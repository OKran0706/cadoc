# canary-system/src/alert_response/slack.py
# Derived from: alert-response/SKILL.md — Slack Alert Formatting
"""
Slack Incoming Webhook integration for canary alerts.
"""

import os
import logging

import requests

logger = logging.getLogger("alert.slack")

SLACK_WEBHOOK = os.environ.get("CANARY_SLACK_WEBHOOK", "")
ALERT_CHANNEL = "#security-canary-alerts"

SEVERITY_EMOJI = {
    "CRITICAL": ":rotating_light:",
    "HIGH": ":warning:",
    "MEDIUM": ":large_yellow_circle:",
    "LOW": ":information_source:",
}

RUNBOOK_BASE = "https://wiki.internal/canary/runbooks"


def post_alert(alert: dict):
    """Post an alert to Slack via Incoming Webhook."""
    severity = alert.get("severity", "HIGH")
    color = {
        "CRITICAL": "#FF0000",
        "HIGH": "#FF6600",
        "MEDIUM": "#FFB300",
        "LOW": "#36A64F",
    }.get(severity, "#888888")

    event = alert.get("event", {})
    k8s = alert.get("k8s", {})
    if not isinstance(k8s, dict):
        k8s = {}

    fields = [
        {"title": "Rule", "value": alert.get("rule_id", ""), "short": True},
        {"title": "Host", "value": alert.get("host", ""), "short": True},
        {"title": "Asset", "value": f'`{event.get("file", event.get("table", "N/A"))}`', "short": False},
        {"title": "Process", "value": f'{event.get("process", "N/A")} (PID {event.get("pid", "N/A")})', "short": True},
        {"title": "User", "value": event.get("user", alert.get("actor", "N/A")), "short": True},
    ]

    if k8s.get("pod"):
        fields += [
            {"title": "Pod", "value": k8s["pod"], "short": True},
            {"title": "Namespace", "value": k8s.get("namespace", ""), "short": True},
        ]

    rule_id = alert.get("rule_id", "unknown")
    alert_id = alert.get("alert_id", "N/A")
    runbook_url = f"{RUNBOOK_BASE}/{rule_id.lower().replace('_', '-')}"

    message = {
        "channel": ALERT_CHANNEL,
        "text": f'{SEVERITY_EMOJI.get(severity, ":grey_question:")} *Canary Alert: {rule_id}*',
        "attachments": [
            {
                "color": color,
                "fields": fields,
                "footer": f"Alert ID: {alert_id} | <{runbook_url}|Runbook>",
                "ts": str(alert.get("ts", "")),
            }
        ],
    }

    try:
        resp = requests.post(SLACK_WEBHOOK, json=message, timeout=10)
        resp.raise_for_status()
        logger.info("Slack alert posted: %s", rule_id)
    except requests.RequestException as e:
        logger.error("Slack post failed: %s", e)
