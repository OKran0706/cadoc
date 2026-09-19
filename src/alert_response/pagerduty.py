# canary-system/src/alert_response/pagerduty.py
# Derived from: alert-response/SKILL.md — PagerDuty Integration
"""
PagerDuty Events API v2 integration for canary alert paging.
"""

import os
import logging

import requests

logger = logging.getLogger("alert.pagerduty")

PAGERDUTY_ROUTING_KEY = os.environ.get("CANARY_PAGERDUTY_KEY", "")

SEVERITY_MAP = {
    "CRITICAL": "critical",
    "HIGH": "error",
    "MEDIUM": "warning",
    "LOW": "info",
}

RUNBOOK_BASE = "https://wiki.internal/canary/runbooks"


def page(alert: dict):
    """Send a PagerDuty alert via Events API v2."""
    payload = {
        "routing_key": PAGERDUTY_ROUTING_KEY,
        "event_action": "trigger",
        "dedup_key": alert.get("alert_id", alert.get("rule_id", "unknown")),
        "payload": {
            "summary": _format_summary(alert),
            "severity": SEVERITY_MAP.get(alert.get("severity", "HIGH"), "error"),
            "timestamp": alert.get("ts", ""),
            "source": alert.get("host", "canary-system"),
            "custom_details": {
                "rule": alert.get("rule_id"),
                "asset": alert.get("event", {}).get("file", alert.get("event", {}).get("table", "N/A")),
                "actor": alert.get("actor", ""),
                "user": alert.get("event", {}).get("user", "N/A"),
                "pod": alert.get("k8s", {}).get("pod", "N/A") if isinstance(alert.get("k8s"), dict) else "N/A",
                "namespace": alert.get("k8s", {}).get("namespace", "N/A") if isinstance(alert.get("k8s"), dict) else "N/A",
                "alert_id": alert.get("alert_id", ""),
                "runbook": _get_runbook_url(alert.get("rule_id", "")),
            },
        },
    }

    try:
        resp = requests.post(
            "https://events.pagerduty.com/v2/enqueue",
            json=payload,
            timeout=10,
        )
        resp.raise_for_status()
        logger.info("PagerDuty alert sent: %s", alert.get("rule_id"))
    except requests.RequestException as e:
        logger.error("PagerDuty send failed: %s", e)
        raise


def _format_summary(alert: dict) -> str:
    """Format a human-readable alert summary for PagerDuty."""
    rule_id = alert.get("rule_id", "UNKNOWN")
    actor = alert.get("actor", "unknown")
    host = alert.get("host", "unknown")

    event = alert.get("event", {})
    asset = event.get("file", event.get("table", event.get("path", "N/A")))

    k8s = alert.get("k8s", {})
    pod = k8s.get("pod") if isinstance(k8s, dict) else None

    if pod:
        return f"[CANARY] {rule_id} — {asset} accessed by {actor}@{host} in pod {pod}"
    return f"[CANARY] {rule_id} — {asset} accessed by {actor}@{host}"


def _get_runbook_url(rule_id: str) -> str:
    """Get the runbook URL for a given rule ID."""
    return f"{RUNBOOK_BASE}/{rule_id.lower().replace('_', '-')}"
