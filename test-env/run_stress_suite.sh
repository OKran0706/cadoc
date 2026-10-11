#!/bin/bash
# test-env/run_stress_suite.sh
# Production-grade stress and backpressure orchestrator script.
# MUST be run inside the Vagrant VM as root.

set -euo pipefail

echo "=========================================================="
echo "      SENTINEL-A PRODUCTION HARDENING STRESS SUITE        "
echo "=========================================================="

# 1. Cleanup previous runs
pkill -f vault || true
pkill -f uvicorn || true
pkill -f 'sentinel-a --config' || true
service auditd restart
sleep 2

# Ensure target directories exist
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
openssl req -x509 -newkey rsa:2048 -keyout /tmp/ca.key -out /tmp/ca.crt -days 365 -nodes -subj "/CN=Test CA"
openssl req -newkey rsa:2048 -nodes -keyout /tmp/client.key -out /tmp/client.csr -subj "/CN=test-client"
openssl x509 -req -in /tmp/client.csr -CA /tmp/ca.crt -CAkey /tmp/ca.key -CAcreateserial -out /tmp/client.crt -days 365

CA_CERT=$(cat /tmp/ca.crt)
CLIENT_CERT=$(cat /tmp/client.crt)
CLIENT_KEY=$(cat /tmp/client.key)

vault secrets enable -path=secret kv-v2 || true
vault kv put secret/canary/sentinels/test-client \
    ca_cert="$CA_CERT" \
    client_cert="$CLIENT_CERT" \
    client_key="$CLIENT_KEY"

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

python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 > /tmp/ingest.log 2>&1 &
INGEST_PID=$!
sleep 5

# 5. Obtain Join Token
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

# 6. Start Sentinel-A in standard mode
export STATE_DIRECTORY="/var/lib/canary"
mkdir -p $STATE_DIRECTORY
rm -f $STATE_DIRECTORY/*

/vagrant/sentinel-a --config /vagrant/config/verify.yaml --join-token $JOIN_TOKEN \
    --deployer-profile app-server \
    --deployer-config /vagrant/config \
    --deployer-templates /opt/sentinel/templates \
    --deployer-interval 600 \
    --deployer-max-jitter 5 > /tmp/sentinel.log 2>&1 &
SENTINEL_PID=$!

echo "Waiting for Sentinel-A to bootstrap..."
sleep 5

# --------------------------------------------------------
# SCENARIO 1: Real-Syscall Multithreaded Storm
# --------------------------------------------------------
echo ""
echo ">>> RUNNING SCENARIO 1: Kernel-Level Syscall Storming <<<"
python3 /vagrant/stress_generator.py --dir /var/backups --workers 12 --duration 15 --rate 250 &
STRESS_GEN_PID=$!

# Sample Sentinel CPU/Memory during load
echo "Sampling Sentinel-A resource consumption under kernel syscall storm..."
for i in {1..3}; do
    sleep 4
    ps -p $SENTINEL_PID -o pid,%cpu,%mem,cmd || true
done

wait $STRESS_GEN_PID || true
echo "Syscall storm finished."
sleep 2

# Check alert generation in logs
ALERT_COUNT=$(grep -c "Posting tamper alert to ingestion service" /tmp/sentinel.log || echo 0)
INGEST_ALERT_COUNT=$(grep -c "SENTINEL_FILE_" /tmp/ingest.log || echo 0)
echo "✓ Syscall Storm Alerts POSTed by Sentinel-A : $ALERT_COUNT"
echo "✓ Syscall Storm Alerts Received by Ingestion : $INGEST_ALERT_COUNT"


# --------------------------------------------------------
# SCENARIO 2: Stdin Line Injection (High Throughput & Backpressure)
# --------------------------------------------------------
echo ""
echo ">>> RUNNING SCENARIO 2: Mock Stdin Injection (Backpressure Check) <<<"
echo "Killing background sentinel-a daemon to keep connection empty..."
kill $SENTINEL_PID || true
sleep 1

# Launch audit-consume directly, redirecting a massive mock stdin stream to it.
# We will inject 15,000 events/second (30,000 records/sec) for 4 seconds.
# This should quickly push active reassembly buffers above the 10,000 limit,
# triggering the Go aggregator's backpressure eviction flow.
echo "Injecting 15,000 events/sec (30,000 lines/sec) directly into audit-consume..."
(python3 /vagrant/stdin_injector.py --rate 15000 --duration 4 | /usr/local/bin/sentinel-a audit-consume > /tmp/audit-consume-stress.log 2>&1) &
CONSUME_PIPE_PID=$!

# Wait for injector to finish sending events
sleep 6

# Gracefully terminate the persistent consumer (since it retries forever on disconnect)
pkill -9 -f 'sentinel-a audit-consume' || true
wait $CONSUME_PIPE_PID || true

# Analyze backpressure logs
EVICTION_COUNT=$(grep -c "Backpressure: evicting event" /tmp/audit-consume-stress.log || echo 0)

echo "----------------------------------------------------------"
echo "STRESS SUITE COMPLETE"
echo "----------------------------------------------------------"
if [ "$EVICTION_COUNT" -gt 0 ]; then
    echo "✓ SUCCESS: Graceful backpressure eviction verified! ($EVICTION_COUNT events evicted)"
else
    echo "❌ FAILED: No backpressure evictions triggered. Check logs."
fi

# Clean up
kill $INGEST_PID || true
pkill -f vault || true
echo "Cleanup completed."
