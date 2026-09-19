# canary-system/src/detection_engine/rules/tier2.py
# Derived from: detection-engine/SKILL.md — Tier 2 Behavioral / Windowed Rules
"""
Tier 2 (behavioral, sliding-window) detection rules.
Require multiple events within time windows before alerting.
"""

import logging
import os
import re
from datetime import datetime

import yaml
import pytz

from detection_engine.sliding_window import SlidingWindowCounter

logger = logging.getLogger("detection.rules.tier2")


# Default Tier 2 rule definitions
DEFAULT_TIER2_RULES = [
    {
        "id": "BULK_CANARY_FILE_READ",
        "name": "Bulk canary file enumeration",
        "description": "5+ canary file stat()/open() within 30 seconds from same process",
        "window_seconds": 30,
        "threshold": 5,
        "key_template": "{host}:{pid}",
        "event_filter": {
            "event_type": ["CANARY_FILE_EVENT"],
            "file_event": ["access", "open", "stat"],
        },
        "alert": {
            "severity": "HIGH",
            "priority": "P1",
            "note": "Likely automated enumeration tool (find, tar, rsync)",
        },
    },
    {
        "id": "DB_SCHEMA_ENUM",
        "name": "Database schema enumeration",
        "description": "20+ information_schema or pg_catalog queries in 60s from same role",
        "window_seconds": 60,
        "threshold": 20,
        "key_template": "{db_host}:{db_user}",
        "event_filter": {"event_type": ["DB_CATALOG_QUERY"]},
        "alert": {
            "severity": "HIGH",
            "priority": "P2",
            "note": "Consistent with sqlmap, pgdump, or manual recon",
        },
    },
    {
        "id": "DB_COPY_TO_DETECTED",
        "name": "COPY TO statement detected",
        "description": "Any COPY TO — data exfiltration attempt",
        "window_seconds": 1,
        "threshold": 1,
        "key_template": "{db_host}:{db_user}",
        "event_filter": {
            "event_type": ["DB_STATEMENT"],
            "statement_contains": ["COPY", "TO"],
        },
        "alert": {"severity": "CRITICAL", "priority": "P1"},
    },
    {
        "id": "OFF_HOURS_PVC_ACCESS",
        "name": "PVC accessed outside business hours",
        "description": "PVC read from non-maintenance pod between 22:00–06:00 UTC",
        "time_filter": {"outside_hours": ["06:00", "22:00"], "timezone": "UTC"},
        "event_filter": {
            "event_type": ["PVC_READ", "PVC_MOUNT"],
            "exclude_pods": ["velero-*", "db-backup-*"],
        },
        "alert": {"severity": "MEDIUM", "priority": "P2"},
    },
    {
        "id": "HIGH_VOLUME_PVC_READ",
        "name": "Abnormal PVC read volume",
        "description": "More than 100 file reads from a PVC mount in 10 seconds",
        "window_seconds": 10,
        "threshold": 100,
        "key_template": "{node}:{pod_name}:{pvc_name}",
        "event_filter": {"event_type": ["PVC_FILE_READ"]},
        "alert": {
            "severity": "HIGH",
            "priority": "P1",
            "note": "Consistent with tar/rsync exfiltration",
        },
    },
    {
        "id": "NEW_NODE_PVC_ACCESS",
        "name": "PVC accessed from historically unseen node",
        "description": "A PVC is accessed from a node not in its historical access baseline",
        "baseline_days": 30,
        "event_filter": {"event_type": ["PVC_MOUNT"]},
        "alert": {"severity": "MEDIUM", "priority": "P2"},
    },
]


class Tier2RuleEngine:
    """Evaluates Tier 2 (behavioral, windowed) detection rules."""

    def __init__(self, rules_path: str = None, suppressions_path: str = None):
        if rules_path and os.path.exists(rules_path):
            with open(rules_path) as f:
                config = yaml.safe_load(f)
                self.rules = config.get("rules", DEFAULT_TIER2_RULES)
        else:
            self.rules = DEFAULT_TIER2_RULES

        # Initialize sliding window counters for each windowed rule
        self.counters = {}
        for rule in self.rules:
            if "window_seconds" in rule:
                self.counters[rule["id"]] = SlidingWindowCounter(
                    window_seconds=rule["window_seconds"],
                    threshold=rule["threshold"],
                )

        # Load suppressions
        self.suppressions = []
        if suppressions_path and os.path.exists(suppressions_path):
            with open(suppressions_path) as f:
                config = yaml.safe_load(f)
                self.suppressions = config.get("suppressions", [])

    def evaluate(self, event: dict) -> list:
        """Evaluate an event against Tier 2 rules. Returns list of alerts."""
        matched_alerts = []
        event_type = event.get("type", "")

        for rule in self.rules:
            # Check event type filter
            event_filter = rule.get("event_filter", {})
            match_types = event_filter.get("event_type", [])
            if match_types and event_type not in match_types:
                continue

            # Check file event sub-filter
            file_events = event_filter.get("file_event", [])
            if file_events and event.get("event", "") not in file_events:
                continue

            # Check statement_contains filter
            stmt_contains = event_filter.get("statement_contains", [])
            if stmt_contains:
                statement = event.get("statement", event.get("line", ""))
                if not all(kw.upper() in statement.upper() for kw in stmt_contains):
                    continue

            # Check pod exclusions
            exclude_pods = event_filter.get("exclude_pods", [])
            pod_name = event.get("pod_name", event.get("pod", ""))
            if exclude_pods and pod_name:
                excluded = False
                for pattern in exclude_pods:
                    if pattern.endswith("*") and pod_name.startswith(pattern[:-1]):
                        excluded = True
                        break
                    elif pod_name == pattern:
                        excluded = True
                        break
                if excluded:
                    continue

            # Check time filter (off-hours detection)
            time_filter = rule.get("time_filter")
            if time_filter:
                if not self._is_outside_hours(time_filter):
                    continue

            # Check suppression
            if self._is_suppressed(rule["id"], event):
                logger.debug("SUPPRESSED: rule=%s", rule["id"])
                continue

            # Windowed rules: add to counter and check threshold
            if rule["id"] in self.counters:
                key = self._build_key(rule.get("key_template", ""), event)
                threshold_exceeded = self.counters[rule["id"]].add(key)
                if not threshold_exceeded:
                    continue

            # Alert!
            alert = {
                "rule_id": rule["id"],
                "rule_name": rule["name"],
                "description": rule.get("description", ""),
                "severity": rule["alert"]["severity"],
                "priority": rule["alert"]["priority"],
                "note": rule["alert"].get("note", ""),
                "response_actions": rule["alert"].get("response", []),
                "event": event,
                "host": event.get("host", ""),
                "actor": event.get("user", event.get("process", "")),
            }
            matched_alerts.append(alert)
            logger.warning(
                "TIER2 MATCH: rule=%s host=%s actor=%s",
                rule["id"], event.get("host"), alert["actor"],
            )

        return matched_alerts

    @staticmethod
    def _build_key(template: str, event: dict) -> str:
        """Build a counter key from template and event data."""
        if not template:
            return str(event.get("host", "")) + ":" + str(event.get("pid", ""))

        key = template
        for field in re.findall(r"\{(\w+)\}", template):
            value = str(event.get(field, "unknown"))
            key = key.replace(f"{{{field}}}", value)
        return key

    @staticmethod
    def _is_outside_hours(time_filter: dict) -> bool:
        """Check if current time is outside the specified hours."""
        tz_name = time_filter.get("timezone", "UTC")
        tz = pytz.timezone(tz_name)
        now = datetime.now(tz)
        hours = time_filter.get("outside_hours", [])
        if len(hours) == 2:
            start_h, start_m = map(int, hours[0].split(":"))
            end_h, end_m = map(int, hours[1].split(":"))
            current_minutes = now.hour * 60 + now.minute
            start_minutes = start_h * 60 + start_m
            end_minutes = end_h * 60 + end_m
            # "outside_hours" means alert if current time is outside [start, end]
            return current_minutes < start_minutes or current_minutes > end_minutes
        return False

    def _is_suppressed(self, rule_id: str, event: dict) -> bool:
        """Check if event matches any suppression rule."""
        for suppression in self.suppressions:
            if suppression.get("rule_id") != rule_id:
                continue

            # Check actor pattern
            actor_pattern = suppression.get("actor_pattern")
            if actor_pattern:
                actor = event.get("user", event.get("process", ""))
                if re.match(actor_pattern, str(actor)):
                    return True

            # Check process name
            proc_name = suppression.get("process_name")
            if proc_name and event.get("process") == proc_name:
                # Check file event sub-suppression
                suppressed_events = suppression.get("file_events_suppressed", [])
                if suppressed_events:
                    if event.get("event", "") in suppressed_events:
                        return True
                    else:
                        continue
                return True

            # Check pod label
            pod_label = suppression.get("pod_label")
            if pod_label and pod_label in str(event.get("labels", {})):
                return True

        return False
