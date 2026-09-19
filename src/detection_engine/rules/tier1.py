# canary-system/src/detection_engine/rules/tier1.py
# Derived from: detection-engine/SKILL.md — Tier 1 Rules
"""
Tier 1 (High-confidence) single-event detection rules.
Any match is a P1 alert — zero tolerance. No behavioral context needed.
"""

import logging
import yaml
import os

logger = logging.getLogger("detection.rules.tier1")

# Default rules — can be overridden via YAML config
DEFAULT_TIER1_RULES = [
    {
        "id": "FILE_CANARY_READ",
        "name": "Canary file accessed",
        "description": "Any open() on a canary file path",
        "match": {"event_type": ["CANARY_FILE_EVENT"], "file_event": ["access", "open"]},
        "exclude": {"process_name": []},
        "alert": {"severity": "CRITICAL", "priority": "P1",
                  "response": ["page", "siem", "quarantine_candidate"]},
    },
    {
        "id": "CANARY_FILE_METADATA_CHANGE",
        "name": "Canary file metadata tampered",
        "description": "chmod/chown/rename on a canary file — evasion attempt",
        "match": {"event_type": ["CANARY_FILE_EVENT"],
                  "file_event": ["attrib", "modify", "move", "delete"]},
        "alert": {"severity": "CRITICAL", "priority": "P1",
                  "response": ["page", "siem", "snapshot_filesystem"]},
    },
    {
        "id": "CANARY_PVC_ACCESSED",
        "name": "Canary PVC file read",
        "match": {"event_type": ["CANARY_PVC_ACCESS"]},
        "alert": {"severity": "CRITICAL", "priority": "P1",
                  "response": ["page", "siem", "isolate_pod"]},
    },
    {
        "id": "CANARY_PVC_MOUNTED",
        "name": "Canary PVC mounted by pod",
        "match": {"event_type": ["CANARY_PVC_MOUNTED"]},
        "alert": {"severity": "CRITICAL", "priority": "P1",
                  "response": ["page", "siem", "delete_pod"]},
    },
    {
        "id": "CANARY_PVC_SNAPSHOT",
        "name": "Canary PVC snapshot created",
        "match": {"event_type": ["CANARY_PVC_SNAPSHOT"]},
        "alert": {"severity": "CRITICAL", "priority": "P1",
                  "response": ["page", "siem", "freeze_snapshot"]},
    },
    {
        "id": "DB_CANARY_TABLE_ACCESS",
        "name": "Canary DB table queried",
        "description": "Any access to a canary schema or table",
        "match": {"event_type": ["DB_CANARY_ACCESS"]},
        "alert": {"severity": "CRITICAL", "priority": "P1",
                  "response": ["page", "siem", "revoke_db_session"]},
    },
    {
        "id": "SENTINEL_KILL_ATTEMPT",
        "name": "Sentinel process targeted",
        "description": "kill() or ptrace directed at sentinel PID",
        "match": {"event_type": ["ALERT_SENTINEL_KILL_ATTEMPT",
                                  "ALERT_SENTINEL_PTRACE_ATTEMPT"]},
        "alert": {"severity": "CRITICAL", "priority": "P1",
                  "response": ["page", "siem", "lock_host"]},
    },
    {
        "id": "LOG_CHAIN_BREAK",
        "name": "Merkle chain broken",
        "description": "Log integrity violation — tampering detected",
        "match": {"event_type": ["MERKLE_CHAIN_BREAK", "SEQUENCE_GAP",
                                  "SIGNATURE_VERIFICATION_FAILED"]},
        "alert": {"severity": "CRITICAL", "priority": "P1",
                  "response": ["page", "siem", "forensic_snapshot"]},
    },
]


class Tier1RuleEngine:
    """Evaluates Tier 1 (single-event, high-confidence) detection rules."""

    def __init__(self, rules_path: str = None):
        if rules_path and os.path.exists(rules_path):
            with open(rules_path) as f:
                config = yaml.safe_load(f)
                self.rules = config.get("rules", DEFAULT_TIER1_RULES)
        else:
            self.rules = DEFAULT_TIER1_RULES

    def evaluate(self, event: dict) -> list:
        """
        Evaluate an event against all Tier 1 rules.
        Returns list of matched rule alerts.
        """
        matched_alerts = []
        event_type = event.get("type", "")
        file_event = event.get("event", event.get("file_event", ""))

        # Independent Validation: Strict Schema Enforcement
        if not self._validate_schema(event):
            return [{
                "rule_id": "MALFORMED_EVENT_SCHEMA",
                "rule_name": "Event failed strict schema validation",
                "description": "The sentinel event violated the expected JSON schema constraints",
                "severity": "HIGH",
                "priority": "P2",
                "response_actions": ["page"],
                "host": event.get("host", "unknown"),
                "actor": "unknown",
                "event": event
            }]

        for rule in self.rules:
            match_spec = rule.get("match", {})
            match_types = match_spec.get("event_type", [])
            match_file_events = match_spec.get("file_event", [])

            # Check event type match
            if event_type not in match_types:
                continue

            # Check file event sub-type if specified
            if match_file_events and file_event and file_event not in match_file_events:
                continue

            # Check exclusions
            exclude = rule.get("exclude", {})
            excluded_processes = exclude.get("process_name", [])
            if excluded_processes and event.get("process") in excluded_processes:
                continue

            # Special case: allow canary-rotator to delete/move files during maintenance
            if event_type == "CANARY_FILE_EVENT" and file_event in ["delete", "move"]:
                is_rotator_name = event.get("process") == "canary-rotator"
                is_rotator_path = event.get("process_binary") == "/opt/canary-deployer/bin/canary-rotator"
                is_rotator_uid = event.get("uid") == 1001

                if is_rotator_name and is_rotator_path and is_rotator_uid:
                    logger.info("Suppressed rotation event for verified canary-rotator")
                    continue

            # Match found!
            alert = {
                "rule_id": rule["id"],
                "rule_name": rule["name"],
                "description": rule.get("description", ""),
                "severity": rule["alert"]["severity"],
                "priority": rule["alert"]["priority"],
                "response_actions": rule["alert"].get("response", []),
                "event": event,
                "host": event.get("host", ""),
                "actor": event.get("user", event.get("process", "")),
            }
            matched_alerts.append(alert)
            logger.warning(
                "TIER1 MATCH: rule=%s event_type=%s host=%s",
                rule["id"], event_type, event.get("host"),
            )

        return matched_alerts

    def _validate_schema(self, event: dict) -> bool:
        """Strictly validate incoming event schema."""
        # This schema enforces the required fields from sentinel-daemon/SKILL.md
        schema = {
            "type": "object",
            "required": ["type", "host", "ts"],
            "properties": {
                "type": {"type": "string", "minLength": 1},
                "host": {"type": "string"},
                "ts":   {"type": "string", "format": "date-time"},
                "process": {"type": "string"},
                "pid": {"type": "integer"},
                "uid": {"type": "integer"},
                "file_path": {"type": "string"},
                "event": {"type": "string"}
            }
        }
        
        # We only strictly validate known sentinel event types for now
        event_type = event.get("type", "")
        if event_type in ["CANARY_FILE_EVENT", "CANARY_PVC_ACCESS", "HEARTBEAT"]:
            try:
                import jsonschema
                jsonschema.validate(instance=event, schema=schema)
                return True
            except ImportError:
                logger.warning("jsonschema not installed, skipping strict validation")
                return True
            except Exception as e:
                logger.error(f"Schema validation failed: {str(e)[:200]}...")
                return False
        return True
