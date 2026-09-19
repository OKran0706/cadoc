#!/bin/bash
# canary-system/scripts/quarantine-host.sh
# Derived from: alert-response/SKILL.md — Host Network Quarantine
# Applies iptables rules to isolate a host

set -euo pipefail

ALERT_ID=${1:?"Usage: $0 <alert_id>"}
SECURITY_TEAM_IP="${CANARY_SECURITY_TEAM_IP:-10.0.1.0/24}"

# Log the action before executing
logger -t canary-response "QUARANTINE_HOST alert_id=$ALERT_ID"

echo "Quarantining host for alert: $ALERT_ID"

# Drop all inbound except security team SSH
iptables -I INPUT 1 -s "$SECURITY_TEAM_IP" -p tcp --dport 22 -j ACCEPT
iptables -I INPUT 2 -j DROP

# Drop all outbound except canary telemetry
CANARY_ENDPOINT=$(grep remote_url /opt/sentinel/config/sentinel.yaml 2>/dev/null | awk '{print $2}' || true)
RULE_NUM=1

if [ -n "$CANARY_ENDPOINT" ]; then
  iptables -I OUTPUT $RULE_NUM -d "$CANARY_ENDPOINT" -j ACCEPT
  ((RULE_NUM++))
fi

iptables -I OUTPUT $RULE_NUM -d "$SECURITY_TEAM_IP" -j ACCEPT
((RULE_NUM++))
iptables -I OUTPUT $RULE_NUM -j DROP

# Save rules for persistence
iptables-save > /etc/iptables/rules.v4 2>/dev/null || true

echo "Host quarantined. Access restricted to security team ($SECURITY_TEAM_IP). Alert: $ALERT_ID"
