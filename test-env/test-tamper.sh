#!/bin/bash
# test-env/test-tamper.sh
# Automated E2E verification of File Tamper Alerts for the app-server profile.
# MUST be run inside the Vagrant VM.

set -euo pipefail

echo "=== Starting File Tamper Alert Verification ==="

# 1. Cleanup previous runs
pkill -f vault || true
pkill -f uvicorn || true
pkill -f 'sentinel-a --config' || true

# Restart auditd to ensure the audit-consume worker is clean and active
service auditd restart
sleep 2

# Ensure all target directories exist
mkdir -p /home/deploy/.ssh
mkdir -p /etc/app
mkdir -p /var/backups
mkdir -p /opt/app/config

# 2. Start Redis and Vault in dev mode
service redis-server start
vault server -dev -dev-root-token-id=root > /tmp/vault.log 2>&1 &
sleep 5
export VAULT_ADDR='http://127.0.0.1:8200'
export VAULT_TOKEN='root'

# 3. Generate Real Certs for Ingestion/Sentinel mTLS
echo "Generating test certificates..."
openssl req -x509 -newkey rsa:2048 -keyout /tmp/ca.key -out /tmp/ca.crt -days 365 -nodes -subj "/CN=Test CA"
openssl req -newkey rsa:2048 -nodes -keyout /tmp/client.key -out /tmp/client.csr -subj "/CN=test-client"
openssl x509 -req -in /tmp/client.csr -CA /tmp/ca.crt -CAkey /tmp/ca.key -CAcreateserial -out /tmp/client.crt -days 365

CA_CERT=$(cat /tmp/ca.crt)
CLIENT_CERT=$(cat /tmp/client.crt)
CLIENT_KEY=$(cat /tmp/client.key)

echo "Configuring Vault secrets..."
vault secrets enable -path=secret kv-v2 || true
vault kv put secret/canary/sentinels/test-client \
    ca_cert="$CA_CERT" \
    client_cert="$CLIENT_CERT" \
    client_key="$CLIENT_KEY"

# Root signing key and maintenance ticket key
vault kv put secret/canary/signer private_key="0000000000000000000000000000000000000000000000000000000000000001"
vault kv put secret/canary/control auth_pubkey="0000000000000000000000000000000000000000000000000000000000000002"

# 4. Start Ingestion Service
cd /opt/canary/src/ingestion_service
export REDIS_URL="redis://127.0.0.1:6379/0"
export VAULT_ADDR="http://127.0.0.1:8200"
export VAULT_ADMIN_TOKEN="root"
export JWT_SECRET="test-secret"
export BOOTSTRAP_JWT_SECRET="bootstrap-secret"
export SKIP_KAFKA="true"

echo "Starting Ingestion Service..."
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 > /tmp/ingest.log 2>&1 &
INGEST_PID=$!
sleep 5

# 5. Obtain Join Token
echo "Obtaining Join Token..."
USER_TOKEN=$(python3 -c "import jwt, time; print(jwt.encode({'sub': 'admin', 'iat': int(time.time()), 'exp': int(time.time()) + 3600}, 'test-secret', algorithm='HS256'))")
JOIN_RESPONSE=$(curl -s -X POST http://127.0.0.1:8000/bootstrap/join \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"client_id": "test-client", "server_id": "test-server"}')

JOIN_TOKEN=$(echo $JOIN_RESPONSE | jq -r .join_token)
if [ "$JOIN_TOKEN" == "null" ] || [ -z "$JOIN_TOKEN" ]; then
    echo "❌ Failed to get join token: $JOIN_RESPONSE"
    exit 1
fi

# 6. Start Sentinel-A in Bootstrap & Production mode (No --dev)
echo "Starting Sentinel-A with app-server profile..."
export STATE_DIRECTORY="/var/lib/canary"
mkdir -p $STATE_DIRECTORY
rm -f $STATE_DIRECTORY/*

# Use verify.yaml config
/vagrant/sentinel-a --config /vagrant/config/verify.yaml --join-token $JOIN_TOKEN \
    --deployer-profile app-server \
    --deployer-config /vagrant/config \
    --deployer-templates /opt/sentinel/templates \
    --deployer-interval 600 \
    --deployer-max-jitter 5 > /tmp/sentinel.log 2>&1 &
SENTINEL_PID=$!

echo "Waiting for Sentinel-A to bootstrap and plant canaries..."
# Wait up to 30 seconds for canary map to be deployed
SUCCESS=0
for i in {1..30}; do
    if grep -q "rotated" /tmp/sentinel.log; then
        echo "✓ Canaries successfully planted!"
        SUCCESS=1
        break
    fi
    sleep 1
done

if [ $SUCCESS -ne 1 ]; then
    echo "❌ Sentinel-A failed to start or plant canaries. Sentinel Log:"
    cat /tmp/sentinel.log
    exit 1
fi

# 7. Find planted canary in /var/backups
CANARY_FILE=$(grep "SET_MAP" /tmp/sentinel.log | grep -o '"/var/backups/[^"]*"' | head -n 1 | tr -d '"')
if [ -z "$CANARY_FILE" ] || [ ! -f "$CANARY_FILE" ]; then
    echo "❌ No canary file found in /var/backups"
    exit 1
fi
echo "Planted canary file: $CANARY_FILE"

# 8. Trigger Tamper (Write)
echo "Modifying canary file to trigger audit event..."
echo "unauthorized edit" >> "$CANARY_FILE"

# 9. Wait for alert to propagate
echo "Waiting for alert propagation..."
sleep 5

# 10. Verify that Sentinel signed and posted the TAMPER event
echo "Checking logs for tamper alert..."
if grep -q "Posting tamper alert to ingestion service" /tmp/sentinel.log; then
    echo "✓ TC-03: Sentinel-A detected modification and posted signed alert successfully!"
else
    echo "❌ TC-03: Sentinel-A did NOT post a tamper alert. Sentinel Log:"
    cat /tmp/sentinel.log
    exit 1
fi

# 11. Cleanup
kill $SENTINEL_PID || true
kill $INGEST_PID || true
pkill -f vault || true

echo "=== Tamper Alert Verification Complete ==="
