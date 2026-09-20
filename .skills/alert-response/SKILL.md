---
name: alert-response
description: "Use this skill for configuring the alerting and automated response pipeline. Covers: PagerDuty integration, Slack alert formatting, SIEM ingest (Splunk/Elastic), automated response actions (pod isolation, credential rotation, PVC snapshot freeze, host network quarantine), and response playbooks per alert type."
depends_on: detection-engine/SKILL.md
---

# Alert & Response Pipeline

## Overview

The alert pipeline is the final layer — it routes enriched alerts from the detection engine to human operators and optionally executes automated response actions.

**Design goals:**
- Zero missed P1 alerts: every Tier 1 detection reaches an on-call engineer within 60 seconds.
- Low noise: behavioral (Tier 2) alerts go to SIEM and ticketing, not paging.
- Automated response for well-understood scenarios to reduce attacker dwell time.
- All automated actions are logged and reversible.

---

## Alert Routing Matrix

| Rule Tier | Alert Type                     | PagerDuty | Slack | SIEM | Auto-Response |
|-----------|-------------------------------|-----------|-------|------|---------------|
| Tier 1    | Canary file/PVC/DB access     | P1 page   | ✓     | ✓    | Optional      |
| Tier 1    | Sentinel kill/ptrace attempt  | P1 page   | ✓     | ✓    | Host lockdown |
| Tier 1    | Log chain break               | P1 page   | ✓     | ✓    | Forensic snap |
| Tier 1    | PVC snapshot (unauthorized)   | P1 page   | ✓     | ✓    | Freeze snap   |
| Tier 2    | Bulk file enumeration         | P2 page   | ✓     | ✓    | Pod isolate   |
| Tier 2    | DB schema enumeration         | –         | ✓     | ✓    | Revoke session|
| Tier 2    | Off-hours PVC access          | –         | ✓     | ✓    | –             |
| Tier 2    | High-volume PVC read          | P1 page   | ✓     | ✓    | Isolate pod   |

---

## Alert Schema

Every alert emitted by the detection engine follows this schema before routing:

```json
{
  "alert_id":    "ale_8f3a2d1e-...",
  "rule_id":     "FILE_CANARY_READ",
  "severity":    "CRITICAL",
  "priority":    "P1",
  "ts":          "2025-01-15T14:32:00.123Z",
  "host":        "app-server-01",
  "actor": {
    "pid":       1337,
    "process":   "curl",
    "user":      "www-data",
    "lineage":   ["bash(1234)", "sshd(1200)"],
    "k8s": {
      "pod":       "api-server-7d9f-x4p2",
      "namespace": "production",
      "node":      "k8s-node-03"
    }
  },
  "asset": {
    "type":      "file",
    "path":      "/home/deploy/.ssh/id_ed25519_deploy.old",
    "canary_id": "c8f3a2d1-..."
  },
  "raw_event":   { "...": "original signed event" },
  "response_actions": ["page", "siem", "quarantine_candidate"]
}
```

---

## PagerDuty Integration

```python
# /opt/canary/alert/pagerduty.py

import requests

PAGERDUTY_ROUTING_KEY = os.environ["CANARY_PAGERDUTY_KEY"]

SEVERITY_MAP = {
    "CRITICAL": "critical",
    "HIGH":     "error",
    "MEDIUM":   "warning",
    "LOW":      "info",
}

def page(alert: dict):
    payload = {
        "routing_key": PAGERDUTY_ROUTING_KEY,
        "event_action": "trigger",
        "dedup_key": alert["alert_id"],
        "payload": {
            "summary": _format_summary(alert),
            "severity": SEVERITY_MAP[alert["severity"]],
            "timestamp": alert["ts"],
            "source": alert["host"],
            "custom_details": {
                "rule":       alert["rule_id"],
                "asset":      alert["asset"]["path"],
                "actor":      alert["actor"]["process"],
                "user":       alert["actor"]["user"],
                "pod":        alert["actor"].get("k8s", {}).get("pod", "N/A"),
                "namespace":  alert["actor"].get("k8s", {}).get("namespace", "N/A"),
                "alert_id":   alert["alert_id"],
                "runbook":    _get_runbook_url(alert["rule_id"]),
            }
        }
    }
    resp = requests.post(
        "https://events.pagerduty.com/v2/enqueue",
        json=payload, timeout=10
    )
    resp.raise_for_status()


def _format_summary(alert: dict) -> str:
    asset = alert["asset"]["path"]
    actor = f'{alert["actor"]["user"]}@{alert["host"]}'
    pod = alert["actor"].get("k8s", {}).get("pod")
    if pod:
        return f"[CANARY] {alert['rule_id']} — {asset} accessed by {actor} in pod {pod}"
    return f"[CANARY] {alert['rule_id']} — {asset} accessed by {actor}"


RUNBOOK_BASE = "https://wiki.internal/canary/runbooks"
def _get_runbook_url(rule_id: str) -> str:
    return f"{RUNBOOK_BASE}/{rule_id.lower().replace('_', '-')}"
```

---

## Slack Alert Formatting

```python
# /opt/canary/alert/slack.py

import requests

SLACK_WEBHOOK = os.environ["CANARY_SLACK_WEBHOOK"]
ALERT_CHANNEL = "#security-canary-alerts"

SEVERITY_EMOJI = {
    "CRITICAL": ":rotating_light:",
    "HIGH":     ":warning:",
    "MEDIUM":   ":large_yellow_circle:",
    "LOW":      ":information_source:",
}

def post_alert(alert: dict):
    color = {
        "CRITICAL": "#FF0000",
        "HIGH":     "#FF6600",
        "MEDIUM":   "#FFB300",
        "LOW":      "#36A64F",
    }.get(alert["severity"], "#888888")

    actor = alert["actor"]
    k8s = actor.get("k8s", {})

    fields = [
        {"title": "Rule",     "value": alert["rule_id"],             "short": True},
        {"title": "Host",     "value": alert["host"],                "short": True},
        {"title": "Asset",    "value": f'`{alert["asset"]["path"]}`',"short": False},
        {"title": "Process",  "value": f'{actor["process"]} (PID {actor["pid"]})', "short": True},
        {"title": "User",     "value": actor["user"],                "short": True},
    ]

    if k8s.get("pod"):
        fields += [
            {"title": "Pod",       "value": k8s["pod"],       "short": True},
            {"title": "Namespace", "value": k8s["namespace"], "short": True},
        ]

    message = {
        "channel": ALERT_CHANNEL,
        "text": f'{SEVERITY_EMOJI[alert["severity"]]} *Canary Alert: {alert["rule_id"]}*',
        "attachments": [{
            "color": color,
            "fields": fields,
            "footer": f'Alert ID: {alert["alert_id"]} | <{_get_runbook_url(alert["rule_id"])}|Runbook>',
            "ts": alert["ts"],
        }]
    }

    requests.post(SLACK_WEBHOOK, json=message, timeout=10)
```

---

## SIEM Ingest

Alerts are also forwarded to the SIEM (Splunk or Elastic) for correlation with other security signals:

```yaml
# Vector sink configuration for SIEM

sinks:
  splunk_hec:
    type: splunk_hec_logs
    inputs: [detection_engine_output]
    endpoint: "https://splunk.internal:8088"
    token: "${SPLUNK_HEC_TOKEN}"
    index: "canary_alerts"
    sourcetype: "canary:detection"
    tls:
      enabled: true
      ca_file: /etc/canary/tls/ca.crt
    encoding:
      codec: json

  elasticsearch:
    type: elasticsearch
    inputs: [detection_engine_output]
    endpoints: ["https://elastic.internal:9200"]
    index: "canary-alerts-%Y.%m.%d"
    auth:
      strategy: basic
      user: canary-writer
      password: "${ELASTIC_PASSWORD}"
    tls:
      enabled: true
      ca_file: /etc/canary/tls/ca.crt
```

---

## Automated Response Actions

**All automated actions are:**
1. Logged to the immutable remote log before execution
2. Reversible (no permanent destructive actions without human approval)
3. Scoped to the minimum blast radius

### Pod Isolation (Kubernetes)

```python
# /opt/canary/response/isolate_pod.py

def isolate_pod(namespace: str, pod_name: str, alert_id: str):
    """
    Applies a restrictive NetworkPolicy to effectively quarantine the pod.
    Does NOT delete the pod (preserves forensic evidence).
    """
    k8s = kubernetes.client.NetworkingV1Api()

    policy = kubernetes.client.V1NetworkPolicy(
        metadata=kubernetes.client.V1ObjectMeta(
            name=f"canary-quarantine-{pod_name}",
            namespace=namespace,
            annotations={"canary-system/alert-id": alert_id,
                          "canary-system/auto-response": "true"},
        ),
        spec=kubernetes.client.V1NetworkPolicySpec(
            pod_selector=kubernetes.client.V1LabelSelector(
                match_labels={"app": _get_pod_app_label(namespace, pod_name)}
            ),
            policy_types=["Ingress", "Egress"],
            # Empty ingress/egress = deny all
            ingress=[],
            egress=[
                # Allow DNS only (for debugging)
                kubernetes.client.V1NetworkPolicyEgressRule(
                    ports=[kubernetes.client.V1NetworkPolicyPort(port=53)]
                )
            ]
        )
    )

    k8s.create_namespaced_network_policy(namespace, policy)
    log_response_action("POD_ISOLATED", alert_id, {"pod": pod_name, "namespace": namespace})
```

### Database Session Revocation

```python
# /opt/canary/response/revoke_db_session.py

def revoke_db_session(db_host: str, backend_pid: int, alert_id: str):
    """
    Terminates the specific database backend that triggered the alert.
    Does NOT revoke the role permanently — human decision required.
    """
    with psycopg2.connect(MONITOR_DB_CONN) as conn:
        cur = conn.cursor()
        # Log before action
        cur.execute(
            "INSERT INTO canary_monitor.response_actions VALUES (%s, %s, %s, %s)",
            (alert_id, "REVOKE_DB_SESSION", db_host, backend_pid)
        )
        # Terminate the session (not cancel — terminate)
        cur.execute("SELECT pg_terminate_backend(%s)", (backend_pid,))
        result = cur.fetchone()[0]
        conn.commit()

    log_response_action("DB_SESSION_TERMINATED", alert_id,
                        {"backend_pid": backend_pid, "success": result})
    return result
```

### PVC Snapshot Freeze

```python
# /opt/canary/response/freeze_snapshot.py

def freeze_unauthorized_snapshot(namespace: str, snapshot_name: str, alert_id: str):
    """
    Adds a finalizer to the VolumeSnapshot to prevent deletion,
    then annotates it for forensic review.
    Forensic snapshot is preserved; not deleted.
    """
    snap_api = kubernetes.client.CustomObjectsApi()

    # Add finalizer (prevents deletion until manually removed)
    patch = {
        "metadata": {
            "finalizers": ["canary-system/forensic-hold"],
            "annotations": {
                "canary-system/alert-id": alert_id,
                "canary-system/status": "quarantined",
                "canary-system/quarantine-time": datetime.utcnow().isoformat(),
            }
        }
    }

    snap_api.patch_namespaced_custom_object(
        group="snapshot.storage.k8s.io",
        version="v1",
        namespace=namespace,
        plural="volumesnapshots",
        name=snapshot_name,
        body=patch,
    )

    log_response_action("SNAPSHOT_FROZEN", alert_id,
                        {"snapshot": snapshot_name, "namespace": namespace})
```

### Host Network Quarantine (Linux, non-K8s)

```bash
# /opt/canary/response/quarantine-host.sh
# Applies iptables rules to isolate a host — allows SSH from security team IP only

ALERT_ID=$1
SECURITY_TEAM_IP="10.0.1.0/24"  # Security team's network

# Log the action before executing
logger -t canary-response "QUARANTINE_HOST alert_id=$ALERT_ID"

# Drop all inbound except security team SSH
iptables -I INPUT 1 -s "$SECURITY_TEAM_IP" -p tcp --dport 22 -j ACCEPT
iptables -I INPUT 2 -j DROP

# Drop all outbound except canary telemetry (so alerts keep flowing)
CANARY_ENDPOINT=$(grep remote_url /opt/sentinel/config/sentinel.yaml | awk '{print $2}')
iptables -I OUTPUT 1 -d "$CANARY_ENDPOINT" -j ACCEPT
iptables -I OUTPUT 2 -d "$SECURITY_TEAM_IP" -j ACCEPT
iptables -I OUTPUT 3 -j DROP

# Save rules for persistence across reboot
iptables-save > /etc/iptables/rules.v4

echo "Host quarantined. Access restricted to security team. Alert: $ALERT_ID"
```

---

## Response Playbooks

Short decision guides for on-call engineers responding to each alert type:

### FILE_CANARY_READ

```
1. Identify the process: check alert.actor.process + alert.actor.lineage
2. Determine if host compromise: is process running as a service account? Under what parent?
3. If K8s: check pod labels and image — is it expected on this node?
4. Collect: /proc/{pid}/maps, /proc/{pid}/cmdline, /proc/{pid}/environ
5. Preserve: take memory dump with 'gcore {pid}' before killing
6. Isolate: run 'response/isolate-pod.py' or quarantine-host.sh
7. Escalate: open war room if lineage traces to sshd or cron (lateral movement indicator)
Runbook: https://wiki.internal/canary/runbooks/file-canary-read
```

### LOG_CHAIN_BREAK

```
1. Identify the gap: check which host and sequence numbers are missing
2. Check if host is reachable: ping, ssh
3. Check sentinel status: systemctl status canary-sentinel-a canary-sentinel-b
4. If sentinel killed: host is likely compromised — escalate immediately
5. Do NOT restart sentinel yet — take full disk image first
6. Check what events exist in the gap window in the remote log (S3/Loki)
7. The gap window is the attacker's window — focus forensics there
Runbook: https://wiki.internal/canary/runbooks/log-chain-break
```

### SENTINEL_KILL_ATTEMPT

```
1. Immediate P1 — this means the attacker knows about the canary system
2. Identify attacker PID from alert.actor.pid
3. Take memory dump before touching anything
4. Quarantine host network (block all egress except canary telemetry)
5. The attacker is sophisticated — assume full host compromise
6. Begin IR process: preserve disk image, notify IR team
Runbook: https://wiki.internal/canary/runbooks/sentinel-kill
```

---

## CVE Response Runbook

**Trigger:** Critical CVE announced in Tetragon, Falco, or Linux eBPF

### Step 1 (0-5 minutes)

Run kill switch immediately:
```bash
ansible-playbook site.yml --tags kill-switch --limit all
```
Confirm `SENTINEL_KILL_SWITCH_ACTIVATED` received from all hosts.

### Step 2 (5-30 minutes)

Assess CVE:
- Is it exploitable remotely or only locally?
- Does it affect our specific kernel version?
- Is a patch available?

### Step 3a (patch available)

- Test patch in staging
- Deploy patched Tetragon/kernel via Ansible
- Re-activate sentinel: `ansible-playbook site.yml --tags sentinel`
- Confirm all hosts return to Level 0

### Step 3b (no patch available)

- Remain at Level 1 (inotify fallback)
- Increase manual monitoring frequency
- Set a review checkpoint every 24 hours
- Do not re-enable eBPF until patch is available and tested

### Step 4

Post-incident review:
- How long were we at reduced coverage?
- Were any canary accesses missed during degradation?
- Do we need to add more inotify coverage to Level 1?

---

## Health Check

```bash
# Verify PagerDuty integration is live
curl -s -X POST https://events.pagerduty.com/v2/enqueue \
  -H "Content-Type: application/json" \
  -d "{\"routing_key\":\"$CANARY_PAGERDUTY_KEY\",\"event_action\":\"trigger\",
       \"dedup_key\":\"test-$(date +%s)\",
       \"payload\":{\"summary\":\"Canary pipeline test — ignore\",
       \"severity\":\"info\",\"source\":\"canary-healthcheck\"}}"

# Verify Slack webhook
curl -s -X POST $CANARY_SLACK_WEBHOOK \
  -H "Content-Type: application/json" \
  -d '{"text":"Canary alert pipeline health check — ignore"}'

# End-to-end test: fire a controlled canary access and trace to PagerDuty
# (Use a test dedup_key so it doesn't wake anyone up)
```

---

## Dependencies

**Python 3.11+** — no language change; alert routing and response actions stay Python.

### Python Packages

```
requests==2.31.0
kubernetes==28.1.0
psycopg2-binary==2.9.9
```

### Runtime Requirements

- PagerDuty Events API v2 routing key
- Slack Incoming Webhook URL
- Splunk HEC token OR Elasticsearch credentials (SIEM)
- Kubernetes API access (for pod isolation / snapshot freeze)
- PostgreSQL monitor connection (for session revocation)
- `iptables` on Linux hosts (for host quarantine)
- All response credentials stored in Vault, fetched at runtime — never in config files
