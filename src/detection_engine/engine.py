# canary-system/src/detection_engine/engine.py
# Derived from: detection-engine/SKILL.md — Event Router + Rule Dispatcher
"""
Detection engine — consumes events from Kafka `canary-events` topic
and dispatches them through Tier 1 and Tier 2 rule engines.
Enriches matched alerts and forwards them to the alert pipeline.
"""

import json
import logging
import os
import time
import threading

import yaml
from kafka import KafkaConsumer

from detection_engine.rules.tier1 import Tier1RuleEngine
from detection_engine.rules.tier2 import Tier2RuleEngine
from detection_engine.enrichment import enrich_alert

logger = logging.getLogger("detection.engine")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)

# --- Alert Deduplication ---
DEDUP_WINDOW_SECONDS = 60


class AlertDeduplicator:
    """
    Deduplicates alerts within a rolling window.
    Key = (rule_id, host, actor)
    Within the window, only the FIRST alert is forwarded.
    """

    def __init__(self):
        self._seen: dict = {}
        self._lock = threading.Lock()

    def process(self, alert: dict):
        key = f"{alert['rule_id']}:{alert.get('host', '')}:{alert.get('actor', '')}"
        now = time.time()

        with self._lock:
            if key in self._seen:
                entry = self._seen[key]
                if now - entry["first_seen"] < DEDUP_WINDOW_SECONDS:
                    entry["count"] += 1
                    return None  # Suppress duplicate

            self._seen[key] = {"first_seen": now, "count": 1}
            alert["dedup_window"] = DEDUP_WINDOW_SECONDS
            return alert

    def cleanup(self):
        """Remove expired entries."""
        now = time.time()
        with self._lock:
            expired = [
                k for k, v in self._seen.items()
                if now - v["first_seen"] > DEDUP_WINDOW_SECONDS * 2
            ]
            for k in expired:
                del self._seen[k]


# --- Main Detection Engine ---


class DetectionEngine:
    """
    Main detection engine.
    Consumes from Kafka, classifies events, and dispatches alerts.
    """

    def __init__(self, config_path: str = "/opt/canary/config"):
        self.kafka_brokers = os.environ.get(
            "CANARY_KAFKA_BROKERS", "kafka-0:9092,kafka-1:9092"
        ).split(",")
        self.topic = "canary-events"

        # Initialize rule engines
        tier1_path = os.path.join(config_path, "tier1.yaml")
        tier2_path = os.path.join(config_path, "tier2.yaml")
        suppressions_path = os.path.join(config_path, "suppressions.yaml")

        self.tier1_engine = Tier1RuleEngine(rules_path=tier1_path)
        self.tier2_engine = Tier2RuleEngine(
            rules_path=tier2_path,
            suppressions_path=suppressions_path,
        )
        self.deduplicator = AlertDeduplicator()

        # K8s client (optional)
        self._k8s_client = None
        try:
            from kubernetes import config as k8s_config, client as k8s_client
            k8s_config.load_incluster_config()
            self._k8s_client = k8s_client.ApiClient()
            logger.info("K8s client initialized")
        except Exception:
            logger.info("K8s client not available — enrichment will skip K8s context")

        # Alert router (lazy import to avoid circular dependency)
        self._alert_router = None

    def _get_alert_router(self):
        """Lazy-load alert router."""
        if self._alert_router is None:
            try:
                from alert_response.router import AlertRouter
                self._alert_router = AlertRouter()
            except ImportError:
                logger.warning("Alert router not available")
        return self._alert_router

    def start(self):
        """Start consuming events from Kafka."""
        logger.info("Detection engine starting (brokers: %s, topic: %s)", self.kafka_brokers, self.topic)

        import hvac
        import ssl

        vault_addr = os.environ.get("VAULT_ADDR")
        vault_token = os.environ.get("VAULT_TOKEN")

        ssl_context = None
        if vault_addr and vault_token:
            logger.info("Initializing Vault client...")
            vault_client = hvac.Client(url=vault_addr, token=vault_token)
            if vault_client.is_authenticated():
                try:
                    secret = vault_client.secrets.kv.v2.read_secret_version(path='canary/kafka')
                    ca_cert = secret['data']['data'].get('ca_cert', '')
                    if ca_cert:
                        ssl_context = ssl.create_default_context()
                        ssl_context.load_verify_locations(cadata=ca_cert)
                        logger.info("Kafka SSL Context loaded securely into zero-disk memory via hvac")
                except Exception as e:
                    logger.error(f"Failed to fetch Kafka certificates dynamically: {e}")

        kwargs = {
            "bootstrap_servers": self.kafka_brokers,
            "group_id": "detection",
            "value_deserializer": lambda m: json.loads(m.decode("utf-8")),
            "auto_offset_reset": "latest",
            "enable_auto_commit": True,
        }
        
        if ssl_context:
            kwargs["security_protocol"] = "SSL"
            kwargs["ssl_context"] = ssl_context

        consumer = KafkaConsumer(
            self.topic,
            **kwargs
        )

        # Start dedup cleanup thread
        cleanup_thread = threading.Thread(target=self._dedup_cleanup_loop, daemon=True)
        cleanup_thread.start()

        # Start tier2 window cleanup thread
        window_cleanup = threading.Thread(target=self._window_cleanup_loop, daemon=True)
        window_cleanup.start()

        logger.info("Detection engine consuming from Kafka...")

        for message in consumer:
            try:
                self._process_event(message.value)
            except Exception as e:
                logger.error("Error processing event: %s — %s", e, message.value)

    def _process_event(self, event: dict):
        """Process a single event through the rule pipeline."""
        # 1. Independent Validation Layer - Signature & Schema
        if "payload" not in event or "signature" not in event:
            # We reject any event that isn't wrapped in a signature
            logger.warning("Rejected unsigned event")
            return

        try:
            inner = json.loads(event["payload"])
            inner["_envelope"] = {
                "hash": event.get("hash"),
                "signature": event.get("signature"),
                "key_id": event.get("key_id"),
                "seq": event.get("seq"),
            }
            event = inner
        except (json.JSONDecodeError, TypeError):
            logger.warning("Rejected malformed event payload")
            return

        # 2. Timestamp Plausibility Check
        try:
            from dateutil.parser import parse as parse_date
            from datetime import datetime, timezone
            
            event_ts_str = event.get("ts")
            if not event_ts_str:
                raise ValueError("Missing timestamp in payload")
                
            event_time = parse_date(event_ts_str)
            now = datetime.now(timezone.utc)
            delta = abs((now - event_time).total_seconds())
            
            if delta > 30:
                self._handle_alert({
                    "rule_id": "SENTINEL_CLOCK_DRIFT",
                    "severity": "HIGH",
                    "priority": "P2",
                    "host": event.get("host", "unknown"),
                    "description": f"Event timestamp drifted {delta}s off local clock",
                    "raw_event": event
                })
                return # Drop event as untrusted
        except Exception as e:
            logger.warning(f"Rejected event with invalid timestamp: {e}")
            return

        event_type = event.get("type", "")
        logger.debug("Processing event: type=%s host=%s", event_type, event.get("host"))

        # 3. Sentinel Capability Check
        if event_type == "SENTINEL_CAPABILITY_SET":
            eff = event.get("effective", [])
            if "CAP_SYS_ADMIN" in eff or "CAP_BPF" in eff:
                self._handle_alert({
                    "rule_id": "SENTINEL_CAPABILITY_LEAK",
                    "severity": "CRITICAL",
                    "priority": "P1",
                    "host": event.get("host", "unknown"),
                    "description": f"Sentinel retained forbidden capabilities: {eff}",
                    "raw_event": event
                })

        # --- Tier 1 Rules (immediate) ---
        tier1_alerts = self.tier1_engine.evaluate(event)
        for alert in tier1_alerts:
            self._handle_alert(alert)

        # --- Tier 2 Rules (behavioral) ---
        tier2_alerts = self.tier2_engine.evaluate(event)
        for alert in tier2_alerts:
            self._handle_alert(alert)

    def _handle_alert(self, alert: dict):
        """Enrich, deduplicate, and dispatch an alert."""
        # Enrich
        alert = enrich_alert(alert, k8s_client=self._k8s_client)

        # Deduplicate
        deduped = self.deduplicator.process(alert)
        if deduped is None:
            return  # Duplicate, suppressed

        # Dispatch to alert router
        router = self._get_alert_router()
        if router:
            try:
                router.route_alert(deduped)
            except Exception as e:
                logger.error("Alert routing failed: %s", e)

        # Log locally
        logger.warning(
            "ALERT: rule=%s severity=%s priority=%s host=%s actor=%s",
            alert["rule_id"], alert["severity"], alert["priority"],
            alert.get("host"), alert.get("actor"),
        )

    def _dedup_cleanup_loop(self):
        while True:
            time.sleep(120)
            self.deduplicator.cleanup()

    def _window_cleanup_loop(self):
        while True:
            time.sleep(300)
            for counter in self.tier2_engine.counters.values():
                counter.cleanup()


def main():
    engine = DetectionEngine()
    engine.start()


if __name__ == "__main__":
    main()
