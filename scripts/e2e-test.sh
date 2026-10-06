#!/bin/bash
set -euo pipefail

export SENTINEL_LOCAL_KEY="0000000000000000000000000000000000000000000000000000000000000001"

echo "=== Compiling Sentinel ==="
(
    export GO111MODULE=on GOOS=linux GOARCH=amd64
    cd src/sentinel
    go build -o ../../test-env/sentinel-a ./cmd/sentinel-a
)

echo "=== Starting E2E Mock Ingestion Server ==="
rm -f e2e-success.tmp mock-server.log
cd scripts
go run mock-server.go > ../mock-server.log 2>&1 &
MOCK_PID=$!
cd ..

cleanup() {
    echo "Cleaning up mock server (PID $MOCK_PID)..."
    kill $MOCK_PID || true
    rm -f e2e-success.tmp
}
trap cleanup EXIT

echo "Waiting for mock server to start..."
sleep 2

echo "=== Deploying and Starting Sentinel in VM ==="
cd test-env || exit 1
vagrant ssh -c "sudo systemctl stop sentinel; sudo pkill -9 sentinel-a || true"
vagrant ssh -c "sudo cp /vagrant/sentinel-a /usr/local/bin/sentinel-a && sudo chmod +x /usr/local/bin/sentinel-a"

# Run Sentinel in background in dev mode
vagrant ssh -c "export SENTINEL_LOCAL_KEY=$SENTINEL_LOCAL_KEY; sudo -E /usr/local/bin/sentinel-a -dev -config /opt/sentinel/config/sentinel.yaml > /tmp/sentinel.log 2>&1 &"

echo "Waiting for Sentinel to boot..."
sleep 3

echo "=== Triggering Audit Event via audit-consume ==="
cat << 'EOF' > audit.log
type=SYSCALL msg=audit(1714295828.000:123): arch=c000003e syscall=2 success=yes exit=3 a0=7ffcd5a2b000 a1=0 a2=0 a3=0 items=1 ppid=1234 pid=5678 auid=1000 uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 tty=pts0 ses=1 comm="cat" exe="/usr/bin/cat" key="canary"
type=PATH msg=audit(1714295828.000:123): item=0 name="/etc/shadow" inode=1234 dev=08:01 mode=0100600 ouid=0 ogid=0 rdev=00:00 nametype=NORMAL cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0
EOF

vagrant ssh -c "sudo cp /vagrant/audit.log /tmp/audit.log"
# Feed the audit log. The 'sleep 10' keeps the pipe open long enough for the aggregator timeout.
vagrant ssh -c "(cat /tmp/audit.log; sleep 10) | sudo /usr/local/bin/sentinel-a audit-consume > /tmp/consume.log 2>&1"
rm audit.log
cd ..

echo "=== Verifying Event Reception ==="
sleep 2

# Check mock-server.log for the received event
if grep -q "Received event" mock-server.log; then
    echo "------------------------------------------------"
    echo "SUCCESS: E2E Test Passed. Event was received by mock server."
    grep "Received event" mock-server.log
    echo "------------------------------------------------"
    exit 0
else
    echo "------------------------------------------------"
    echo "FAILURE: E2E Test Failed. No event received."
    echo "Sentinel Log:"
    cd test-env && vagrant ssh -c "tail -n 20 /tmp/sentinel.log" && cd ..
    echo "Mock Server Log:"
    cat mock-server.log
    echo "------------------------------------------------"
    exit 1
fi
