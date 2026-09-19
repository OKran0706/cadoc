#!/bin/bash
# canary-system/scripts/red-team-sim.sh
# Derived from: threat-model/SKILL.md — Red-Team Simulation Procedures

set -euo pipefail

echo "=== Canary Red-Team Simulation ==="
echo "CAUTION: This will trigger real alerts. Brief your on-call team first."
echo ""

RED_TEAM_USER="redteam-$(date +%Y%m%d)"

# --- Exercise 1: File Canary Access ---
exercise_1() {
  echo "--- Exercise 1: File Canary Access ---"
  echo "Expected: P1 alert within 60 seconds"

  CANARY_PATH=$(jq -r '.canaries[0].path // empty' /opt/canary/config/canary-map.json)
  if [ -z "$CANARY_PATH" ] || [ ! -f "$CANARY_PATH" ]; then
    echo "✗ No canary file found. Deploy canaries first."
    return 1
  fi

  START=$(date +%s)
  cat "$CANARY_PATH" > /dev/null 2>&1
  sleep 10
  END=$(date +%s)
  ELAPSED=$((END - START))
  echo "Access completed in ${ELAPSED}s. Check PagerDuty for alert."
  echo "Target: < 60 seconds | Acceptable: < 120 seconds | Fail: > 300 seconds"
}

# --- Exercise 2: Bulk Enumeration ---
exercise_2() {
  echo "--- Exercise 2: Bulk Enumeration Simulation ---"
  echo "Expected: BULK_CANARY_FILE_READ alert within 35s of 5th stat()"

  PATHS=$(jq -r '.canaries[].path' /opt/canary/config/canary-map.json | head -10)
  for path in $PATHS; do
    stat "$path" 2>/dev/null || true
    sleep 1
  done
  echo "Enumeration complete. Check for BULK_CANARY_FILE_READ alert."
}

# --- Exercise 3: Database Canary Access ---
exercise_3() {
  echo "--- Exercise 3: Database Canary Access ---"
  echo "Expected: DB_CANARY_ACCESS alert fires"

  psql -U app_readonly -c "SELECT * FROM _system_config.secrets LIMIT 1;" 2>&1 || true
  echo "Query attempted. Check for DB_CANARY_ACCESS alert."
}

# --- Exercise 4: Sentinel Kill Attempt ---
exercise_4() {
  echo "--- Exercise 4: Sentinel Kill Attempt ---"
  echo "CAUTION: This will trigger a P1 alert."

  if [ -f /run/canary/sentinel-a.pid ]; then
    PID=$(cat /run/canary/sentinel-a.pid)
    kill -TERM "$PID" 2>/dev/null || true
    echo "Sent SIGTERM to sentinel-a (PID $PID)"
    sleep 5
    echo "Verify: sentinel-a restarts, SENTINEL_KILL_ATTEMPT alert fires"
  else
    echo "✗ sentinel-a PID file not found"
  fi
}

# --- Exercise 5: Log Tampering ---
exercise_5() {
  echo "--- Exercise 5: Log Tampering Attempt ---"
  echo "Expected: LOG_CHAIN_BREAK alert within 60 seconds"

  if [ -f /opt/sentinel/logs/local-chain.log ]; then
    truncate -s 0 /opt/sentinel/logs/local-chain.log
    echo "Local log truncated. Remote log should continue."
    echo "Check for LOG_CHAIN_BREAK alert."
  else
    echo "✗ Local chain log not found"
  fi
}

# Run selected exercise
case "${1:-all}" in
  1) exercise_1 ;;
  2) exercise_2 ;;
  3) exercise_3 ;;
  4) exercise_4 ;;
  5) exercise_5 ;;
  all)
    exercise_1
    echo ""
    exercise_2
    echo ""
    exercise_3
    ;;
  *)
    echo "Usage: $0 {1|2|3|4|5|all}"
    exit 1
    ;;
esac
