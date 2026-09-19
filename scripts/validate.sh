#!/bin/bash
# canary-system/scripts/validate.sh
# Derived from: deployment/SKILL.md — Post-Deploy Validation

set -euo pipefail

echo "=== Canary System Post-Deploy Validation ==="
FAIL=0

# 1. Sentinel processes running
if systemctl is-active canary-sentinel-a canary-sentinel-b &>/dev/null; then
  echo "✓ Sentinel processes active"
else
  echo "✗ Sentinel not running"; ((FAIL++))
fi

# 2. Heartbeat events flowing to Kafka
LAST_HB=$(kafkacat -b "${CANARY_KAFKA_BROKERS:-kafka-0:9092}" -t canary-heartbeats -C -o -1 -c 1 2>/dev/null \
  | jq -r '.ts // empty')
if [ -n "$LAST_HB" ]; then
  echo "✓ Heartbeat in Kafka: $LAST_HB"
else
  echo "✗ No heartbeat in Kafka"; ((FAIL++))
fi

# 3. Canary files exist and are watched
if [ -f /opt/canary/config/canary-map.json ]; then
  CANARY_COUNT=$(jq '.canaries | length' /opt/canary/config/canary-map.json)
  if [ "$CANARY_COUNT" -gt 0 ]; then
    echo "✓ $CANARY_COUNT canary files registered"
  else
    echo "✗ No canary files registered"; ((FAIL++))
  fi
else
  echo "✗ canary-map.json not found"; ((FAIL++))
fi

# 4. Trigger a canary file access and verify alert fires
if [ -f /opt/canary/config/canary-map.json ]; then
  TRIGGER_PATH=$(jq -r '.canaries[0].path // empty' /opt/canary/config/canary-map.json)
  if [ -n "$TRIGGER_PATH" ] && [ -f "$TRIGGER_PATH" ]; then
    cat "$TRIGGER_PATH" > /dev/null 2>&1
    sleep 5
    ALERT=$(kafkacat -b "${CANARY_KAFKA_BROKERS:-kafka-0:9092}" -t canary-events -C -o -10 -c 10 2>/dev/null \
      | jq "select(.type == \"CANARY_FILE_EVENT\") | .file" | grep -c "$TRIGGER_PATH" || true)
    if [ "$ALERT" -gt 0 ]; then
      echo "✓ File canary access detected"
    else
      echo "✗ File canary access NOT detected"; ((FAIL++))
    fi
  fi
fi

# 5. Verify Merkle chain is unbroken
if [ -x /opt/sentinel/bin/sentinel-verify ]; then
  if /opt/sentinel/bin/sentinel-verify --check-chain --last 100 2>/dev/null; then
    echo "✓ Merkle chain intact"
  else
    echo "✗ Merkle chain broken"; ((FAIL++))
  fi
fi

# 6. Verify remote log is receiving events
REMOTE_COUNT=$(curl -sf "${CANARY_REMOTE_LOG_ENDPOINT:-http://localhost:8080}/api/count?last=5m" 2>/dev/null \
  | jq '.count // 0' || echo "0")
if [ "${REMOTE_COUNT:-0}" -gt 0 ]; then
  echo "✓ Remote log receiving events ($REMOTE_COUNT in last 5m)"
else
  echo "✗ Remote log not receiving events"; ((FAIL++))
fi

echo ""
TOTAL=6
PASSED=$((TOTAL - FAIL))
echo "Validation: $PASSED passed, $FAIL failed"
if [ $FAIL -eq 0 ]; then
  echo "DEPLOYMENT HEALTHY"
  exit 0
else
  echo "DEPLOYMENT HAS ISSUES — investigate before proceeding"
  exit 1
fi
