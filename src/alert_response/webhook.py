# canary-system/src/alert_response/webhook.py
"""
Generic Webhook Dispatcher
Posts alert JSON directly to a configurable HTTP endpoint (e.g., Slack, MS Teams, discord, custom SaaS)
"""

import json
import logging
import os
import requests

logger = logging.getLogger("alert.webhook")

# Provide fallback for local testing
WEBHOOK_URL = os.environ.get("CANARY_WEBHOOK_URL", "")
WEBHOOK_TOKEN = os.environ.get("CANARY_WEBHOOK_TOKEN", "")

def dispatch(alert: dict):
    """Sends the JSON alert payload to the configured webhook."""
    if not WEBHOOK_URL:
        logger.warning(f"No CANARY_WEBHOOK_URL configured — dropping alert {alert.get('alert_id')}")
        return

    headers = {
        "Content-Type": "application/json"
    }
    if WEBHOOK_TOKEN:
        headers["Authorization"] = f"Bearer {WEBHOOK_TOKEN}"
    
    payload = {
        "version": "1.0",
        "source": "canary-detection-engine",
        "data": alert
    }
    
    try:
        resp = requests.post(WEBHOOK_URL, json=payload, headers=headers, timeout=5)
        resp.raise_for_status()
        logger.info(f"Successfully posted alert {alert.get('alert_id')} to webhook.")
    except Exception as e:
        logger.error(f"Failed to dispatch alert to {WEBHOOK_URL}: {e}")
        # Fallback local log
        try:
            with open("/var/log/canary/emergency_alerts.json", "a") as f:
                f.write(json.dumps(alert) + "\n")
        except IOError:
            pass
        raise
