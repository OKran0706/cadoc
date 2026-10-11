#!/bin/bash
# test-env/verify-host-backend.sh
# End-to-end VM verification against the host-side docker compose backend.
# MUST be run inside the Vagrant VM.

set -euo pipefail

BACKEND_BASE_URL="${BACKEND_BASE_URL:-http://192.168.56.1:8000}"
CONFIG_PATH="${CONFIG_PATH:-/vagrant/config/verify-host.yaml}"
SENTINEL_BIN="${SENTINEL_BIN:-/vagrant/sentinel-a}"
STATE_DIRECTORY="${STATE_DIRECTORY:-/var/lib/canary}"
JWT_SECRET="${JWT_SECRET:-test-secret}"

echo "=== Verifying Sentinel-A against host docker-compose backend ==="
echo "Backend: $BACKEND_BASE_URL"
echo "Config:  $CONFIG_PATH"

cleanup() {
    pkill -f 'sentinel-a --config' || true
}
trap cleanup EXIT

service auditd restart
sleep 2

mkdir -p /home/deploy/.ssh
mkdir -p /etc/app
mkdir -p /var/backups
mkdir -p /opt/app/config

if [ ! -x "$SENTINEL_BIN" ]; then
    echo "Sentinel binary not found at $SENTINEL_BIN"
    exit 1
fi

if ! curl -fsS "$BACKEND_BASE_URL/health" > /tmp/host-backend-health.json; then
    echo "Host backend is not reachable from the VM."
    exit 1
fi
echo "Backend health:"
cat /tmp/host-backend-health.json

USER_TOKEN=$(python3 -c "import jwt, time; print(jwt.encode({'sub': 'admin', 'iat': int(time.time()), 'exp': int(time.time()) + 3600}, '$JWT_SECRET', algorithm='HS256'))")
JOIN_RESPONSE=$(curl -fsS -X POST "$BACKEND_BASE_URL/bootstrap/join" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"client_id": "test-client", "server_id": "sentinel-vm"}')

JOIN_TOKEN=$(echo "$JOIN_RESPONSE" | jq -r .join_token)
if [ "$JOIN_TOKEN" = "null" ] || [ -z "$JOIN_TOKEN" ]; then
    echo "Failed to mint join token: $JOIN_RESPONSE"
    exit 1
fi
echo "Join token acquired."

mkdir -p "$STATE_DIRECTORY"
rm -f "$STATE_DIRECTORY"/*

echo "Starting Sentinel-A with host backend bootstrap..."
"$SENTINEL_BIN" --config "$CONFIG_PATH" --join-token "$JOIN_TOKEN" \
    --deployer-profile app-server \
    --deployer-config /vagrant/config \
    --deployer-templates /opt/sentinel/templates \
    --deployer-interval 600 \
    --deployer-max-jitter 5 > /tmp/sentinel-host-backend.log 2>&1 &
SENTINEL_PID=$!

BOOTSTRAP_OK=0
for i in {1..45}; do
    if grep -q "Initial bootstrap successful" /tmp/sentinel-host-backend.log; then
        BOOTSTRAP_OK=1
        break
    fi
    if ! ps -p $SENTINEL_PID > /dev/null; then
        break
    fi
    sleep 1
done

if [ $BOOTSTRAP_OK -ne 1 ]; then
    echo "Bootstrap failed. Sentinel log:"
    cat /tmp/sentinel-host-backend.log
    exit 1
fi

if [ ! -f "$STATE_DIRECTORY/mtls.crt" ]; then
    echo "Bootstrap completed but mtls.crt was not persisted."
    cat /tmp/sentinel-host-backend.log
    exit 1
fi

echo "Bootstrap succeeded. Waiting for canary deployment..."
DEPLOY_OK=0
for i in {1..45}; do
    if grep -q "rotated" /tmp/sentinel-host-backend.log; then
        DEPLOY_OK=1
        break
    fi
    sleep 1
done

if [ $DEPLOY_OK -ne 1 ]; then
    echo "Sentinel started, but no canary rotation was observed."
    cat /tmp/sentinel-host-backend.log
    exit 1
fi

CANARY_FILE=$(grep "SET_MAP" /tmp/sentinel-host-backend.log | grep -o '"/var/backups/[^"]*"' | head -n 1 | tr -d '"')
if [ -z "$CANARY_FILE" ] || [ ! -f "$CANARY_FILE" ]; then
    echo "No planted canary file found under /var/backups."
    cat /tmp/sentinel-host-backend.log
    exit 1
fi
echo "Planted canary file: $CANARY_FILE"

echo "Triggering tamper event..."
echo "unauthorized edit" >> "$CANARY_FILE"
sleep 5

if ! grep -q "Posting tamper alert to ingestion service" /tmp/sentinel-host-backend.log; then
    echo "Tamper event was not posted to the ingestion service."
    cat /tmp/sentinel-host-backend.log
    exit 1
fi
echo "Tamper alert was posted."

echo "Testing restart recovery without join token..."
kill $SENTINEL_PID || true
sleep 2
"$SENTINEL_BIN" --config "$CONFIG_PATH" \
    --deployer-profile app-server \
    --deployer-config /vagrant/config \
    --deployer-templates /opt/sentinel/templates \
    --deployer-interval 600 \
    --deployer-max-jitter 5 > /tmp/sentinel-host-backend-recovery.log 2>&1 &
RECOVERY_PID=$!

RECOVERY_OK=0
for i in {1..30}; do
    if grep -q "Credential renewal successful" /tmp/sentinel-host-backend-recovery.log; then
        RECOVERY_OK=1
        break
    fi
    if ! ps -p $RECOVERY_PID > /dev/null; then
        break
    fi
    sleep 1
done

if [ $RECOVERY_OK -ne 1 ]; then
    echo "Recovery failed. Sentinel log:"
    cat /tmp/sentinel-host-backend-recovery.log
    exit 1
fi

echo "Recovery succeeded."
kill $RECOVERY_PID || true
echo "=== Host backend verification complete ==="
