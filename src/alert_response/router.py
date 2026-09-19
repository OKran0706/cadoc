# canary-system/src/alert_response/router.py
# Derived from: alert-response/SKILL.md — Alert Routing Matrix
"""
Alert router — dispatches enriched alerts to PagerDuty, Slack, SIEM,
and optionally triggers automated response actions.
"""

import logging
import uuid
from datetime import datetime, timezone

from alert_response import pagerduty, slack

logger = logging.getLogger("alert.router")

# Alert routing matrix from alert-response/SKILL.md
ROUTING_MATRIX = {
    "FILE_CANARY_READ":           {"pagerduty": "P1", "slack": True, "siem": True, "auto_response": "quarantine_candidate"},
    "CANARY_FILE_METADATA_CHANGE":{"pagerduty": "P1", "slack": True, "siem": True, "auto_response": None},
    "CANARY_PVC_ACCESSED":        {"pagerduty": "P1", "slack": True, "siem": True, "auto_response": "isolate_pod"},
    "CANARY_PVC_MOUNTED":         {"pagerduty": "P1", "slack": True, "siem": True, "auto_response": "isolate_pod"},
    "CANARY_PVC_SNAPSHOT":        {"pagerduty": "P1", "slack": True, "siem": True, "auto_response": "freeze_snapshot"},
    "DB_CANARY_TABLE_ACCESS":     {"pagerduty": "P1", "slack": True, "siem": True, "auto_response": "revoke_db_session"},
    "SENTINEL_KILL_ATTEMPT":      {"pagerduty": "P1", "slack": True, "siem": True, "auto_response": "lock_host"},
    "LOG_CHAIN_BREAK":            {"pagerduty": "P1", "slack": True, "siem": True, "auto_response": "forensic_snapshot"},
    "BULK_CANARY_FILE_READ":      {"pagerduty": "P2", "slack": True, "siem": True, "auto_response": "isolate_pod"},
    "DB_SCHEMA_ENUM":             {"pagerduty": None, "slack": True, "siem": True, "auto_response": "revoke_db_session"},
    "OFF_HOURS_PVC_ACCESS":       {"pagerduty": None, "slack": True, "siem": True, "auto_response": None},
    "HIGH_VOLUME_PVC_READ":       {"pagerduty": "P1", "slack": True, "siem": True, "auto_response": "isolate_pod"},
}


class AlertRouter:
    """Routes alerts to the appropriate channels based on the routing matrix."""

    def __init__(self):
        self.response_handlers = self._load_response_handlers()

    def _load_response_handlers(self) -> dict:
        """Lazy-load automated response handlers."""
        handlers = {}
        try:
            from alert_response.response import isolate_pod, revoke_db_session, freeze_snapshot, quarantine_host
            handlers["isolate_pod"] = isolate_pod.isolate_pod
            handlers["quarantine_candidate"] = isolate_pod.isolate_pod  # Same handler
            handlers["revoke_db_session"] = revoke_db_session.revoke_db_session
            handlers["freeze_snapshot"] = freeze_snapshot.freeze_unauthorized_snapshot
            handlers["lock_host"] = quarantine_host.quarantine_host
            handlers["forensic_snapshot"] = freeze_snapshot.freeze_unauthorized_snapshot
        except ImportError as e:
            logger.warning("Some response handlers not available: %s", e)
        return handlers

    def route_alert(self, alert: dict):
        """Route an alert through all configured channels."""
        rule_id = alert.get("rule_id", "")
        routing = ROUTING_MATRIX.get(rule_id, {"slack": True, "siem": True})

        # Assign alert ID
        if "alert_id" not in alert:
            alert["alert_id"] = f"ale_{uuid.uuid4()}"

        # Set timestamp
        if "ts" not in alert:
            alert["ts"] = datetime.now(timezone.utc).isoformat()

        logger.info(
            "Routing alert: rule=%s priority=%s",
            rule_id, routing.get("pagerduty", "none"),
        )

        # PagerDuty
        if routing.get("pagerduty"):
            try:
                pagerduty.page(alert)
            except Exception as e:
                logger.error("PagerDuty routing failed: %s", e)

        # Slack
        if routing.get("slack"):
            try:
                slack.post_alert(alert)
            except Exception as e:
                logger.error("Slack routing failed: %s", e)

        # SIEM (log to structured format for Vector to pick up)
        if routing.get("siem"):
            self._emit_siem(alert)

        # Automated response
        auto_response = routing.get("auto_response")
        if auto_response and auto_response in self.response_handlers:
            self._execute_response(auto_response, alert)

    def _emit_siem(self, alert: dict):
        """Emit alert in SIEM-compatible format."""
        import json
        logger.info("SIEM: %s", json.dumps({
            "alert_id": alert.get("alert_id"),
            "rule_id": alert.get("rule_id"),
            "severity": alert.get("severity"),
            "host": alert.get("host"),
            "ts": alert.get("ts"),
        }))

    def _execute_response(self, action: str, alert: dict):
        """Execute an automated response action."""
        handler = self.response_handlers.get(action)
        if not handler:
            logger.warning("No handler for response action: %s", action)
            return

        try:
            logger.info("Executing auto-response: %s for alert %s", action, alert.get("alert_id"))
            event = alert.get("event", {})
            k8s = alert.get("k8s", {})

            if action in ("isolate_pod", "quarantine_candidate"):
                namespace = k8s.get("namespace", event.get("namespace", "default"))
                pod = k8s.get("pod", event.get("pod", ""))
                if pod:
                    handler(namespace, pod, alert.get("alert_id", ""))

            elif action == "revoke_db_session":
                db_host = event.get("db_host", event.get("host", ""))
                backend_pid = event.get("backend_pid", event.get("pid", 0))
                if backend_pid:
                    handler(db_host, int(backend_pid), alert.get("alert_id", ""))

            elif action in ("freeze_snapshot", "forensic_snapshot"):
                namespace = k8s.get("namespace", event.get("namespace", "default"))
                snapshot = event.get("snapshot", event.get("snapshot_name", ""))
                if snapshot:
                    handler(namespace, snapshot, alert.get("alert_id", ""))

            elif action == "lock_host":
                handler(alert.get("alert_id", ""))

        except Exception as e:
            logger.error("Auto-response %s failed: %s", action, e)
