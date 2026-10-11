#!/bin/bash
# test-env/setup-verify.sh
# Integrated verification script for Phase 22 (Identity Bootstrapping)
# To be run inside the Vagrant VM.

set -euo pipefail

echo "=== Setting up Verification Environment inside VM ==="

# 0. Cleanup previous runs
pkill -f vault || true
pkill -f uvicorn || true
pkill -f sentinel-a || true

# 1. Install Redis, Vault, and net-tools
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y redis-server curl gpg python3-pip net-tools jq

# Install Vault
if ! command -v vault &> /dev/null; then
    curl -fsSL https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/hashicorp.list
    apt-get update && apt-get install -y vault
fi

# 2. Start Redis and Vault
service redis-server start
vault server -dev -dev-root-token-id=root > /tmp/vault.log 2>&1 &
sleep 5
export VAULT_ADDR='http://127.0.0.1:8200'
export VAULT_TOKEN='root'

# 3. Generate Real Certs for Test
echo "Generating certificates..."
openssl req -x509 -newkey rsa:2048 -keyout /tmp/ca.key -out /tmp/ca.crt -days 365 -nodes -subj "/CN=Test CA"
openssl req -newkey rsa:2048 -nodes -keyout /tmp/client.key -out /tmp/client.csr -subj "/CN=test-client"
openssl x509 -req -in /tmp/client.csr -CA /tmp/ca.crt -CAkey /tmp/ca.key -CAcreateserial -out /tmp/client.crt -days 365

# Load them into variables, escaping newlines for Vault
CA_CERT=$(cat /tmp/ca.crt)
CLIENT_CERT=$(cat /tmp/client.crt)
CLIENT_KEY=$(cat /tmp/client.key)

echo "Configuring Vault with real certs..."
vault secrets enable -path=secret kv-v2 || true
vault kv put secret/canary/sentinels/test-client \
    ca_cert="$CA_CERT" \
    client_cert="$CLIENT_CERT" \
    client_key="$CLIENT_KEY"
vault kv put secret/canary/signer private_key="0000000000000000000000000000000000000000000000000000000000000001"

# 4. Install Python dependencies for Ingestion Service
cd /opt/canary/src/ingestion_service
pip3 install -r requirements.txt

# 5. Environment Variables for Ingestion Service
export REDIS_URL="redis://127.0.0.1:6379/0"
export VAULT_ADDR="http://127.0.0.1:8200"
export VAULT_ADMIN_TOKEN="root"
export JWT_SECRET="test-secret"
export BOOTSTRAP_JWT_SECRET="bootstrap-secret"
export SKIP_KAFKA="true"

# 6. Start Ingestion Service in background
echo "Starting Ingestion Service..."
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 > /tmp/ingest.log 2>&1 &
INGEST_PID=$!
sleep 10

# 7. Debug: Check if Ingestion Service is listening
if ! netstat -tpln | grep :8000; then
    echo "Ingestion Service not listening!"
    cat /tmp/ingest.log
    exit 1
fi

echo "Obtaining Join Token from Ingestion Service..."
USER_TOKEN=$(python3 -c "import jwt, time; print(jwt.encode({'sub': 'admin', 'iat': int(time.time()), 'exp': int(time.time()) + 3600}, 'test-secret', algorithm='HS256'))")

JOIN_RESPONSE=$(curl -s -X POST http://127.0.0.1:8000/bootstrap/join \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"client_id": "test-client", "server_id": "test-server"}')

JOIN_TOKEN=$(echo $JOIN_RESPONSE | jq -r .join_token)
if [ "$JOIN_TOKEN" == "null" ]; then
    echo "Failed to get join token: $JOIN_RESPONSE"
    cat /tmp/ingest.log
    exit 1
fi
echo "JOIN_TOKEN acquired: $JOIN_TOKEN"

# 8. Run Sentinel Bootstrap
echo "Running Sentinel Bootstrap..."
export STATE_DIRECTORY="/var/lib/canary"
mkdir -p $STATE_DIRECTORY
rm -f $STATE_DIRECTORY/*

/vagrant/sentinel-a --config /vagrant/config/verify.yaml --join-token $JOIN_TOKEN > /tmp/sentinel.log 2>&1 &
SENTINEL_PID=$!
sleep 10

# 9. Verify Results
echo "Checking results in $STATE_DIRECTORY..."
ls -R $STATE_DIRECTORY

if [ -f "$STATE_DIRECTORY/mtls.crt" ]; then
    echo "✓ TC-01: Fresh Bootstrap PASSED (Certs persisted)"
else
    echo "✗ TC-01: Fresh Bootstrap FAILED (Certs missing)"
    cat /tmp/sentinel.log
    exit 1
fi

# 10. Test Recovery Path
echo "Testing Recovery Path (restart without token)..."
kill $SENTINEL_PID || true
sleep 2
/vagrant/sentinel-a --config /vagrant/config/verify.yaml > /tmp/sentinel-recovery.log 2>&1 &
RECOVERY_PID=$!
sleep 10

# Check if sentinel is still running (recovery successful)
if ps -p $RECOVERY_PID > /dev/null; then
    echo "✓ TC-02: Restart Recovery PASSED"
else
    echo "✗ TC-02: Restart Recovery FAILED"
    cat /tmp/sentinel-recovery.log
    exit 1
fi

# Cleanup
kill $RECOVERY_PID || true
kill $INGEST_PID || true
pkill -f vault || true

echo "=== Verification Complete ==="
