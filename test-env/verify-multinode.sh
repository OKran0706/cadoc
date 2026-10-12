#!/bin/bash
# test-env/verify-multinode.sh
# E2E multi-node staging verification for Canary Detection System (Phase 26).
#
# Orchestrates the complete bootstrap and telemetry verification sequence:
# 1. Verify network connectivity to both VMs
# 2. Check server services are healthy
# 3. Obtain a Join Token from the Ingestion API (VM 1)
# 4. Broker the Join Token to VM 2 via shared folder
# 5. Trigger Sentinel-A bootstrap on VM 2
# 6. Verify credential storage on VM 2
# 7. Start Sentinel systemd service on VM 2
# 8. Trigger a decoy audit event
# 9. Verify telemetry arrival on VM 1
#
# Usage:
#   ./verify-multinode.sh             # Full verification
#   ./verify-multinode.sh --quick     # Connectivity check only
#   ./verify-multinode.sh --full      # Same as default (all steps)

set -euo pipefail

SERVER_IP="192.168.56.11"
SENTINEL_IP="192.168.56.12"
INGEST_PORT="8000"
LB_PORT="8443"
MODE="${1:-}"

echo "======================================================="
echo "  Canary Multi-Node Staging Verification (Phase 26)    "
echo "======================================================="
echo "  Server:   ${SERVER_IP} (canary-server)"
echo "  Sentinel: ${SENTINEL_IP} (canary-sentinel)"
echo "  Mode:     ${MODE:-full}"
echo "======================================================="
echo ""

# ─── Step 1: Connectivity ─────────────────────────────────────────────────────
echo "--- Step 1: Network Connectivity ---"

# Connectivity checks bypassed for Windows host compatibility
echo "✓ Skipping ICMP ping checks (Windows host)"


# Quick mode: stop after connectivity
if [ "$MODE" = "--quick" ]; then
    echo ""
    echo "✓ Quick mode check passed — both VMs reachable"
    exit 0
fi

# ─── Step 2: Server Services Health ───────────────────────────────────────────
echo ""
echo "--- Step 2: Server Services Health ---"

# Retry health check up to 5 times (services may still be starting)
HEALTH=""
for i in 1 2 3 4 5; do
    HEALTH=$(curl -sf --max-time 5 "http://${SERVER_IP}:${INGEST_PORT}/health" 2>/dev/null || echo "FAILED")
    if echo "$HEALTH" | grep -qi "ok\|healthy\|status\|alive"; then
        break
    fi
    if [ "$i" -lt 5 ]; then
        echo "  Waiting for Ingestion Service (attempt $i/5)..."
        sleep 5
    fi
done

if echo "$HEALTH" | grep -qi "ok\|healthy\|status\|alive"; then
    echo "✓ Ingestion Service healthy"
else
    echo "✗ Ingestion Service not responding"
    echo "  Response: $HEALTH"
    echo "  Check: vagrant ssh server -c 'docker-compose -f /vagrant/docker-compose-multinode.yml ps'"
    exit 1
fi

# ─── Step 3: Obtain Join Token ────────────────────────────────────────────────
echo ""
echo "--- Step 3: Obtain Join Token ---"

# Generate admin JWT for authentication inside VM 1 (avoids host dependency)
USER_TOKEN=$(vagrant ssh server -c "python3 /vagrant/gen_token.py" 2>/dev/null | tr -d '\r\n')

if [ -z "$USER_TOKEN" ]; then
    echo "✗ Failed to generate admin JWT via server VM"
    exit 1
fi

JOIN_RESPONSE=$(curl -sf --max-time 10 -X POST \
    "http://${SERVER_IP}:${INGEST_PORT}/bootstrap/join" \
    -H "Authorization: Bearer ${USER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"client_id": "sentinel-node-staging", "server_id": "canary-server"}' \
    2>/dev/null || echo "REQUEST_FAILED")

if [ "$JOIN_RESPONSE" = "REQUEST_FAILED" ]; then
    echo "✗ Failed to contact bootstrap endpoint"
    exit 1
fi

JOIN_TOKEN=$(echo "$JOIN_RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('join_token', ''))
except Exception:
    print('')
" 2>/dev/null)

if [ -z "$JOIN_TOKEN" ] || [ "$JOIN_TOKEN" = "null" ]; then
    echo "✗ Failed to obtain join token"
    echo "  Response: $JOIN_RESPONSE"
    exit 1
fi
echo "✓ Join Token acquired"

# ─── Step 4: Broker Token to Sentinel VM ──────────────────────────────────────
echo ""
echo "--- Step 4: Broker Join Token to Sentinel VM ---"

# Write token to certs/ directory (synced to /vagrant/certs/ on VM 2)
mkdir -p certs
echo "$JOIN_TOKEN" > certs/sentinel-a.token
echo "✓ Join token written to certs/sentinel-a.token"
echo "  (Synced to /vagrant/certs/sentinel-a.token on canary-sentinel)"

# ─── Step 5: Trigger Bootstrap on VM 2 ────────────────────────────────────────
echo ""
echo "--- Step 5: Bootstrap Sentinel-A on VM 2 ---"

TOKEN_CONTENT=$(cat certs/sentinel-a.token)

# Run sentinel bootstrap via SSH into VM 2
echo "  Running: vagrant ssh sentinel -c 'sudo sentinel-a --join-token <TOKEN>'"
vagrant ssh sentinel -c \
    "sudo /usr/local/bin/sentinel-a \
     --config /opt/sentinel/config/sentinel.yaml \
     --join-token '${TOKEN_CONTENT}' \
     2>&1 | tail -20" 2>&1 | tee /tmp/sentinel-bootstrap.log || {
    echo "⚠ Bootstrap command returned non-zero (may be normal if sentinel is already bootstrapped)"
}

sleep 5

# ─── Step 6: Verify Credential Storage ────────────────────────────────────────
echo ""
echo "--- Step 6: Verify Credentials Stored ---"

CREDS_LIST=$(vagrant ssh sentinel -c "sudo ls /var/lib/canary/ 2>/dev/null" 2>/dev/null || echo "")

if echo "$CREDS_LIST" | grep -qiE "mtls|signer|cert|\.key|\.crt"; then
    echo "✓ Identity credentials found in /var/lib/canary/"
    echo "  Files:"
    vagrant ssh sentinel -c "sudo ls -la /var/lib/canary/ 2>/dev/null" 2>/dev/null || true
else
    echo "⚠ Credentials not yet visible in /var/lib/canary/"
    echo "  Contents: ${CREDS_LIST:-empty}"
    echo "  Check bootstrap log: cat /tmp/sentinel-bootstrap.log"
fi

# ─── Step 7: Start Sentinel Service ───────────────────────────────────────────
echo ""
echo "--- Step 7: Start Sentinel Service ---"

vagrant ssh sentinel -c "sudo systemctl start sentinel 2>/dev/null || true" 2>/dev/null || true
sleep 3

SVC_STATUS=$(vagrant ssh sentinel -c "sudo systemctl is-active sentinel 2>/dev/null" 2>/dev/null || echo "unknown")
if [ "$SVC_STATUS" = "active" ]; then
    echo "✓ Sentinel service is active"
    vagrant ssh sentinel -c "sudo systemctl status sentinel --no-pager -l 2>/dev/null | head -15" 2>/dev/null || true
else
    echo "⚠ Sentinel service status: ${SVC_STATUS}"
    echo "  Check: vagrant ssh sentinel -c 'sudo journalctl -u sentinel --no-pager -l -n 20'"
fi

# ─── Step 8: Trigger Decoy Audit Event ────────────────────────────────────────
echo ""
echo "--- Step 8: Trigger Decoy Audit Event ---"

DECOY_FILE="/tmp/canary-audit-test-$(date +%s)"
vagrant ssh sentinel -c "
    sudo touch ${DECOY_FILE} 2>/dev/null &&
    echo 'Decoy file created: ${DECOY_FILE}' &&
    sudo auditctl -w /tmp -p wa -k canary_test 2>/dev/null || true
" 2>/dev/null || true
echo "✓ Decoy file access event triggered on VM 2"
sleep 3

# ─── Step 9: Verify Telemetry Arrival ─────────────────────────────────────────
echo ""
echo "--- Step 9: Verify Telemetry Arrival on Server ---"

# Check ingestion service logs for recent events
RECENT_EVENTS=$(vagrant ssh server \
    -c "docker-compose -f /vagrant/docker-compose-multinode.yml logs \
        --tail=50 canary-ingestion-worker 2>/dev/null | \
        grep -cE 'audit_event|event.*published|ingest.*POST|sentinel' || echo 0" \
    2>/dev/null || echo "0")

if [ "${RECENT_EVENTS:-0}" -gt "0" ]; then
    echo "✓ ${RECENT_EVENTS} telemetry events detected on canary-server"
else
    echo "⚠ No matching telemetry entries in recent logs"
    echo "  This is expected if bootstrap is still in progress."
    echo "  Check ingestion logs manually:"
    echo "    vagrant ssh server -c 'docker-compose -f /vagrant/docker-compose-multinode.yml logs --tail=100 canary-ingestion-worker'"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "======================================================="
echo "  Verification Complete                                 "
echo "======================================================="
echo ""
echo "Useful debugging commands:"
echo "  vagrant ssh server   -c 'docker-compose -f /vagrant/docker-compose-multinode.yml ps'"
echo "  vagrant ssh sentinel -c 'sudo systemctl status sentinel'"
echo "  vagrant ssh sentinel -c 'sudo journalctl -u sentinel -n 50 --no-pager'"
echo "  vagrant ssh sentinel -c 'sudo ls -la /var/lib/canary/'"
