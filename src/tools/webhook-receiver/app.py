from flask import Flask, request, jsonify
import logging
import json
import os
from datetime import datetime

# Configure logging to stdout
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] WebhookReceiver: %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Optional token to verify authorization header
EXPECTED_TOKEN = os.environ.get("WEBHOOK_TOKEN", "")

@app.route("/api/alerts/canary", methods=["POST"])
def receive_alert():
    # 1. Verify Authorization Header (if token is set)
    if EXPECTED_TOKEN:
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            logger.warning("Rejected request: Missing 'Bearer ' prefix in Authorization header")
            return jsonify({"error": "Unauthorized"}), 401
        
        token = auth_header.split(" ")[1]
        if token != EXPECTED_TOKEN:
            logger.warning("Rejected request: Invalid token")
            return jsonify({"error": "Unauthorized"}), 401

    # 2. Parse JSON Payload
    try:
        alert = request.get_json()
        if not alert:
            logger.warning("Rejected request: Missing JSON body")
            return jsonify({"error": "Bad Request: JSON body required"}), 400
    except Exception as e:
        logger.error(f"Failed to parse JSON: {e}")
        return jsonify({"error": "Invalid JSON"}), 400

    # 3. Extract data from Envelope (fallback to raw if missing)
    if alert.get("source") == "canary-detection-engine":
        alert_data = alert.get("data", {})
    else:
        # Fallback for older flat payloads or missing envelopes
        alert_data = alert

    # 4. Log the Alert (in a real SaaS, this would write to a DB)
    rule_id = alert_data.get("rule_id", "UNKNOWN_RULE")
    severity = alert_data.get("severity", "UNKNOWN")
    host = alert_data.get("host", "unknown-host")
    
    logger.info(f"🚨 RECEIVED ALERT [{severity}] {rule_id}")
    logger.info(f"   ► Host: {host}")
    if "description" in alert_data:
        logger.info(f"   ► Desc: {alert_data['description']}")
    
    # Dump full payload for debugging
    logger.debug(f"Full Payload: {json.dumps(alert, indent=2)}")

    return jsonify({"status": "received", "timestamp": datetime.utcnow().isoformat()}), 200

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    logger.info(f"Starting generic webhook receiver on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
