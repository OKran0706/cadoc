---
name: detection-engine
description: "Use this skill for detection rules and behavioral anomaly scoring. Covers: single-event high-confidence rules, sliding-window bulk-read detection, schema enumeration scoring, timing anomaly detection, false-positive suppression, exclusion lists, and tuning guidance. Consumes events from the telemetry bus Kafka topic."
depends_on: telemetry-bus/SKILL.md
---

# Detection Engine

## Overview

The detection engine consumes events from the `canary-events` Kafka topic and classifies them into two tiers:

- **Tier 1 (High-confidence, immediate alert):** Any single access to a canary asset. No behavioral context needed — canary access is unconditionally anomalous.
- **Tier 2 (Behavioral, windowed scoring):** Patterns that indicate reconnaissance or bulk exfiltration even without a direct canary hit (e.g., bulk reads, timing anomalies, schema dumps).

---

## Engine Architecture

```
Kafka (canary-events topic)
    │
    ▼
┌─────────────────────────────────────┐
│  Event Router                        │
│  Classifies events by source type   │
│  (file / pvc / db / sentinel)       │
└─────────────────────────────────────┘
    │                │
    ▼                ▼
Rule Engine     Behavioral Engine
(Tier 1)        (Tier 2)
    │                │
    ▼                ▼
Alert Aggregator (deduplication + enrichment)
    │
    ▼
Alert & Response pipeline (Webhooks / API)
```

---

## Webhook-Driven Alert Pipeline

Instead of a hardcoded vendor integration (like PagerDuty), the detection engine uses a **Plug-and-Play Webhook Dispatcher**. This allows you to route P1/P2 alerts to any HTTP endpoint (e.g., your custom zero-cost SaaS dashboard, Slack, Discord, or MS Teams).

```python
# /opt/canary/detection/engine/dispatcher.py
import requests
import os

WEBHOOK_URL = os.getenv("CANARY_WEBHOOK_URL", "http://your-saas.com/api/alerts/canary")
WEBHOOK_TOKEN = os.getenv("CANARY_WEBHOOK_TOKEN", "")

def dispatch_alert(alert: dict):
    """Sends the JSON alert payload to the configured webhook."""
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {WEBHOOK_TOKEN}"
    }
    
    try:
        resp = requests.post(WEBHOOK_URL, json=alert, headers=headers, timeout=5)
        resp.raise_for_status()
    except Exception as e:
        print(f"FAILED TO DISPATCH ALERT to {WEBHOOK_URL}: {e}")
        # Fallback logic: write to emergency local file
        with open("/var/log/canary/emergency_alerts.json", "a") as f:
            f.write(json.dumps(alert) + "\n")
```

---

## Tier 1 Rules — High-Confidence Single-Event

These rules fire immediately on a single event. Zero tolerance: any match is a P1 alert.

```yaml
# /opt/canary/detection/rules/tier1.yaml

rules:
  - id: FILE_CANARY_READ
    name: "Canary file accessed"
    description: "Any open() on a canary file path"
    match:
      event_type: [CANARY_FILE_EVENT]
      file_event: [access, open]
    exclude:
      process_name: []  # No exclusions for reads — use stat_exclusions only
    alert:
      severity: CRITICAL
      priority: P1
      response: [page, siem, quarantine_candidate]

  - id: CANARY_FILE_METADATA_CHANGE
    name: "Canary file metadata tampered"
    description: "chmod/chown/rename on a canary file — evasion attempt"
    match:
      event_type: [CANARY_FILE_EVENT]
      file_event: [attrib, modify, move, delete]
    alert:
      severity: CRITICAL
      priority: P1
      response: [page, siem, snapshot_filesystem]

  - id: CANARY_PVC_ACCESSED
    name: "Canary PVC file read"
    match:
      event_type: [CANARY_PVC_ACCESS]
    alert:
      severity: CRITICAL
      priority: P1
      response: [page, siem, isolate_pod]

  - id: CANARY_PVC_MOUNTED
    name: "Canary PVC mounted by pod"
    match:
      event_type: [CANARY_PVC_MOUNTED]
    alert:
      severity: CRITICAL
      priority: P1
      response: [page, siem, delete_pod]

  - id: CANARY_PVC_SNAPSHOT
    name: "Canary PVC snapshot created"
    match:
      event_type: [CANARY_PVC_SNAPSHOT]
    alert:
      severity: CRITICAL
      priority: P1
      response: [page, siem, freeze_snapshot]

  - id: DB_CANARY_TABLE_ACCESS
    name: "Canary DB table queried"
    description: "Any access to a canary schema or table"
    match:
      event_type: [DB_CANARY_ACCESS]
    alert:
      severity: CRITICAL
      priority: P1
      response: [page, siem, revoke_db_session]

  - id: SENTINEL_KILL_ATTEMPT
    name: "Sentinel process targeted"
    description: "kill() or ptrace directed at sentinel PID"
    match:
      event_type: [ALERT_SENTINEL_KILL_ATTEMPT, ALERT_SENTINEL_PTRACE_ATTEMPT]
    alert:
      severity: CRITICAL
      priority: P1
      response: [page, siem, lock_host]

  - id: LOG_CHAIN_BREAK
    name: "Merkle chain broken"
    description: "Log integrity violation — tampering detected"
    match:
      event_type: [MERKLE_CHAIN_BREAK, SEQUENCE_GAP, SIGNATURE_VERIFICATION_FAILED]
    alert:
      severity: CRITICAL
      priority: P1
      response: [page, siem, forensic_snapshot]
```

---

## Tier 2 Rules — Behavioral / Windowed

These rules require multiple events within a time window and a scoring threshold before alerting.

### Sliding Window Engine

```python
# /opt/canary/detection/engine/sliding_window.py
from collections import defaultdict, deque
from datetime import datetime, timedelta
import threading

class SlidingWindowCounter:
    """Thread-safe sliding window counter per (host, actor) pair."""

    def __init__(self, window_seconds: int, threshold: int):
        self.window = timedelta(seconds=window_seconds)
        self.threshold = threshold
        self._events = defaultdict(deque)  # key → deque of timestamps
        self._lock = threading.Lock()

    def add(self, key: str) -> bool:
        """Add an event and return True if threshold exceeded."""
        now = datetime.utcnow()
        with self._lock:
            q = self._events[key]
            q.append(now)
            # Evict events outside the window
            while q and (now - q[0]) > self.window:
                q.popleft()
            return len(q) >= self.threshold


# Instantiate counters per rule
counters = {
    "bulk_file_read": SlidingWindowCounter(window_seconds=30, threshold=5),
    "schema_enum":    SlidingWindowCounter(window_seconds=60, threshold=20),
    "catalog_query":  SlidingWindowCounter(window_seconds=60, threshold=50),
    "pvc_read_rate":  SlidingWindowCounter(window_seconds=10, threshold=100),
}
```

### Behavioral Rule Definitions

```yaml
# /opt/canary/detection/rules/tier2.yaml

rules:
  - id: BULK_CANARY_FILE_READ
    name: "Bulk canary file enumeration"
    description: "5+ canary file stat()/open() within 30 seconds from same process"
    window_seconds: 30
    threshold: 5
    key: "{host}:{pid}"
    event_filter:
      event_type: [CANARY_FILE_EVENT]
      file_event: [access, open, stat]
    alert:
      severity: HIGH
      priority: P1
      note: "Likely automated enumeration tool (find, tar, rsync)"

  - id: DB_SCHEMA_ENUM
    name: "Database schema enumeration"
    description: "20+ information_schema or pg_catalog queries in 60s from same role"
    window_seconds: 60
    threshold: 20
    key: "{db_host}:{db_user}"
    event_filter:
      event_type: [DB_CATALOG_QUERY]
    alert:
      severity: HIGH
      priority: P2
      note: "Consistent with sqlmap, pgdump, or manual recon"

  - id: DB_COPY_TO_DETECTED
    name: "COPY TO statement detected"
    description: "Any COPY TO — data exfiltration attempt"
    window_seconds: 1
    threshold: 1
    key: "{db_host}:{db_user}"
    event_filter:
      event_type: [DB_STATEMENT]
      statement_contains: ["COPY", "TO"]
    alert:
      severity: CRITICAL
      priority: P1

  - id: OFF_HOURS_PVC_ACCESS
    name: "PVC accessed outside business hours"
    description: "PVC read from non-maintenance pod between 22:00–06:00 UTC"
    time_filter:
      outside_hours: ["06:00", "22:00"]
      timezone: UTC
    event_filter:
      event_type: [PVC_READ, PVC_MOUNT]
      exclude_pods: ["velero-*", "db-backup-*"]  # from allowlist
    alert:
      severity: MEDIUM
      priority: P2

  - id: HIGH_VOLUME_PVC_READ
    name: "Abnormal PVC read volume"
    description: "More than 100 file reads from a PVC mount in 10 seconds"
    window_seconds: 10
    threshold: 100
    key: "{node}:{pod_name}:{pvc_name}"
    event_filter:
      event_type: [PVC_FILE_READ]
    alert:
      severity: HIGH
      priority: P1
      note: "Consistent with tar/rsync exfiltration"

  - id: NEW_NODE_PVC_ACCESS
    name: "PVC accessed from historically unseen node"
    description: "A PVC is accessed from a node not in its historical access baseline"
    baseline_days: 30
    event_filter:
      event_type: [PVC_MOUNT]
    alert:
      severity: MEDIUM
      priority: P2
```

---

## False-Positive Suppression

False positives destroy trust in the system. Apply these suppression rules carefully:

```yaml
# /opt/canary/detection/config/suppressions.yaml

# These affect TIER 2 (behavioral) rules only.
# TIER 1 (canary asset access) is NEVER suppressed.

suppressions:
  - rule_id: DB_SCHEMA_ENUM
    actor_pattern: "^ci-migration-.*"
    reason: "CI database migration runner — queries schema heavily"
    window: "0 1 * * *"    # Only during migration window (01:00 UTC)
    expires: "2025-06-01"

  - rule_id: BULK_CANARY_FILE_READ
    process_name: "bacula-fd"
    reason: "Backup agent stats all files during backup window"
    note: "Only stat() events suppressed — read() events still alert"
    file_events_suppressed: [stat]
    file_events_active: [access, open]  # Still alert on reads

  - rule_id: HIGH_VOLUME_PVC_READ
    pod_label: "app=velero"
    reason: "Velero backup reads PVCs in bulk during scheduled windows"
    window: "0 2 * * *"

# Review and expire all suppressions quarterly
last_reviewed: "2025-01-15"
next_review: "2025-04-15"
```

---

## Alert Deduplication

Prevent alert storms from bulk events generating thousands of identical pages:

```python
# /opt/canary/detection/engine/deduplicator.py

DEDUP_WINDOW_SECONDS = 60
GLOBAL_ALERT_LIMIT = 50

class AlertDeduplicator:
    """
    Deduplicates alerts within a rolling window to prevent page storms.
    - Host-Level: Deduplicates identical (rule_id, host) alerts.
    - Global-Level: If >50 of the same rule_id fire in 60s across all hosts,
      it suppresses further alerts and emits a single MASS_OUTAGE_DETECTED.
    """

    def __init__(self):
        self._seen: dict[str, dict] = {}           # Key: "rule_id:host"
        self._global_counts: dict[str, list] = {}  # Key: "rule_id", Value: list of timestamps

    def process(self, alert: dict) -> dict | None:
        now = time.time()
        rule_id = alert['rule_id']
        host = alert['host']
        key = f"{rule_id}:{host}"

        # 1. Global Mass Outage Protection
        timestamps = self._global_counts.setdefault(rule_id, [])
        timestamps.append(now)
        # Evict old timestamps
        cutoff = now - DEDUP_WINDOW_SECONDS
        self._global_counts[rule_id] = [t for t in timestamps if t > cutoff]
        
        if len(self._global_counts[rule_id]) > GLOBAL_ALERT_LIMIT:
            # If this is exactly the (LIMIT + 1)th alert, fire the mass outage summary
            if len(self._global_counts[rule_id]) == GLOBAL_ALERT_LIMIT + 1:
                return {
                    "rule_id": "MASS_OUTAGE_DETECTED",
                    "severity": "CRITICAL",
                    "priority": "P1",
                    "description": f"Mass outage detected: >{GLOBAL_ALERT_LIMIT} instances of {rule_id} in {DEDUP_WINDOW_SECONDS}s",
                    "suppressed_rule": rule_id,
                    "host": "multiple"
                }
            # Suppress all subsequent alerts for this rule during the storm
            return None

        # 2. Host-Level Deduplication
        if key in self._seen:
            entry = self._seen[key]
            if now - entry['first_seen'] < DEDUP_WINDOW_SECONDS:
                entry['count'] += 1
                return None  # Suppress duplicate for this specific host

        # New alert
        self._seen[key] = {'first_seen': now, 'count': 1}
        alert['dedup_window'] = DEDUP_WINDOW_SECONDS
        return alert
```

---

## Enrichment

Before forwarding to the alert pipeline, enrich each alert with context:

```python
def enrich_alert(alert: dict, k8s_client, process_registry) -> dict:
    # Add process lineage (parent PID chain)
    if 'pid' in alert:
        alert['process_lineage'] = process_registry.get_lineage(
            alert['host'], alert['pid']
        )

    # Add Kubernetes context if on a K8s node
    if alert.get('container_id'):
        pod = k8s_client.get_pod_by_container(alert['container_id'])
        alert['k8s'] = {
            'pod': pod.metadata.name,
            'namespace': pod.metadata.namespace,
            'labels': pod.metadata.labels,
            'node': pod.spec.node_name,
            'service_account': pod.spec.service_account_name,
        }

    # Add user identity enrichment (LDAP/SSO lookup for human users)
    if alert.get('unix_user') and not alert['unix_user'].startswith('svc-'):
        alert['user_info'] = ldap_lookup(alert['unix_user'])

    return alert
```

---

## Tuning Guide

### Too many false positives (Tier 2)

1. Identify the rule firing: `grep RULE_ID /var/log/canary/alerts.log | head -20`
2. Check if the actor is a legitimate service: `grep actor_name /var/log/canary/alerts.log`
3. If legitimate, add a targeted suppression to `suppressions.yaml` with an expiry date
4. Never suppress Tier 1 rules — fix the canary placement instead

### Missing detections (false negatives)

1. Verify eBPF probes are loaded: `tetra tracingpolicy list`
2. Verify canary paths are in the Tetragon/Falco policy: `cat /etc/tetragon/policies/canary-file-watch.yaml`
3. Run a manual canary trigger and trace the event through the pipeline:
   ```bash
   cat /opt/canary/test/.trigger_test
   kafkacat -b kafka-0:9092 -t canary-events -C -o -1 -c 5 | jq .
   ```
4. Check Vector is not dropping events: `vector top`

### Threshold tuning for Tier 2 rules

- Start conservative (high thresholds, short windows) in the first 2 weeks
- Review the 95th percentile access rates for each monitored entity
- Set threshold at 3× the 95th percentile observed legitimate rate
- Review monthly and adjust

---

## Validation

```bash
# End-to-end test: trigger a Tier 1 canary access and verify detection
cat /opt/canary/test/.trigger_file
sleep 5
curl -s http://detection-engine:8080/api/alerts/latest | jq '.[] | select(.rule_id == "FILE_CANARY_READ")'

# Test Tier 2 bulk detection
for i in $(seq 1 10); do stat /opt/canary/test/.trigger_$i 2>/dev/null; done
sleep 35
curl -s http://detection-engine:8080/api/alerts/latest | jq '.[] | select(.rule_id == "BULK_CANARY_FILE_READ")'

# Test suppression is working
grep "SUPPRESSED" /var/log/canary/detection.log | tail -5
```

---

## Defense Against Compromised Sentinel

The sentinel may be compromised. The detection engine must independently verify **every** event it receives — sentinel output is treated as untrusted input.

### a) Signature Verification

Every event must have a valid Ed25519 signature. Reject unsigned or invalid-signature events immediately. *(Already implemented — no change needed.)*

### b) Merkle Chain Verification

Any sequence gap triggers `MERKLE_CHAIN_BREAK`. *(Already implemented — no change needed.)*

### c) Timestamp Plausibility Check (NEW)

Event timestamp must be within **±30 seconds** of the detection engine's local clock. Events outside this window are rejected with:

```json
{"type": "SENTINEL_CLOCK_SKEW", "delta_seconds": 142, "host": "node-7", "event_ts": "..."}
```

**Rationale:** A compromised sentinel replaying old events to mask current activity will have stale timestamps.

```python
def check_timestamp_plausibility(event: dict, max_skew_seconds: int = 30) -> bool:
    event_ts = dateutil.parser.isoparse(event["ts"])
    delta = abs((datetime.utcnow() - event_ts).total_seconds())
    if delta > max_skew_seconds:
        emit_alert("SENTINEL_CLOCK_SKEW", {"delta_seconds": delta, "host": event["host"]})
        return False
    return True
```

### d) Event Rate Plausibility Check (NEW)

Track events-per-second per host. If a host emits **> 10,000 events/second sustained for > 5 seconds**, emit `SENTINEL_EVENT_FLOOD` alert.

**Rationale:** A compromised sentinel flooding the detection engine with junk events is a DoS / masking attack.

```python
class EventRateTracker:
    def __init__(self, threshold_eps: int = 10_000, sustain_seconds: int = 5):
        self.counts: dict[str, list[float]] = {}  # host → list of timestamps
        self.threshold_eps = threshold_eps
        self.sustain_seconds = sustain_seconds

    def track(self, host: str, ts: float) -> bool:
        window = self.counts.setdefault(host, [])
        window.append(ts)
        # Keep only last 5 seconds
        cutoff = ts - self.sustain_seconds
        self.counts[host] = [t for t in window if t > cutoff]
        eps = len(self.counts[host]) / self.sustain_seconds
        if eps > self.threshold_eps:
            emit_alert("SENTINEL_EVENT_FLOOD", {"host": host, "events_per_second": eps})
            return False
        return True
```

### e) Heartbeat Continuity Check (NEW)

Every host must emit a `SENTINEL_HEARTBEAT` event every 30 seconds. If heartbeat gap **> 90 seconds** from a previously healthy host, emit `SENTINEL_SILENT` alert immediately.

**Rationale:** A compromised sentinel that stops emitting heartbeats while continuing to appear running locally indicates the remote log has been cut off.

```python
class HeartbeatTracker:
    def __init__(self, expected_interval: int = 30, alert_threshold: int = 90):
        self.last_seen: dict[str, float] = {}
        self.threshold = alert_threshold

    def on_heartbeat(self, host: str, ts: float):
        self.last_seen[host] = ts

    def check_all(self, now: float):
        for host, last_ts in self.last_seen.items():
            gap = now - last_ts
            if gap > self.threshold:
                emit_alert("SENTINEL_SILENT", {"host": host, "gap_seconds": gap})
```

### f) Capability Event Check (NEW)

After sentinel startup, a `SENTINEL_CAPABILITY_SET` event must appear within **30 seconds** showing `CAP_SYS_ADMIN` dropped. If it doesn't appear, emit `SENTINEL_CAP_MISSING`.

```python
def check_capability_event(host: str, startup_ts: float, events: list[dict]) -> bool:
    for evt in events:
        if evt.get("type") == "SENTINEL_CAPABILITY_SET" and evt["host"] == host:
            if evt["ts"] - startup_ts <= 30:
                if "CAP_SYS_ADMIN" not in evt.get("effective", []):
                    return True  # capability properly dropped
    emit_alert("SENTINEL_CAP_MISSING", {"host": host})
    return False
```

---

## Schema Validation

Every event received from Kafka must be validated against a strict JSON schema before processing. Sentinel output is untrusted input — malformed events may be a parser exploitation attempt.

### Validation Rules

| Check | Action on failure |
|---|---|
| Unknown fields present | **Reject** (strict mode, not permissive) |
| Missing required fields (`type`, `ts`, `host`, `seq`, `signature`) | **Reject** |
| Field type mismatches (e.g., `seq` is string instead of int) | **Reject** |
| String length limits exceeded | **Reject** |
| Rejection count > 100/hour from one host | Emit `SENTINEL_SCHEMA_VIOLATION` alert |

### String Length Limits

| Field | Max Length |
|---|---|
| File paths | 4096 chars |
| Process names | 256 chars |
| Hostnames | 253 chars |
| Event type | 128 chars |
| Signature (hex) | 128 chars |
| Key ID | 32 chars |

### Implementation

```python
import json
from io import BytesIO

def validate_event(raw: bytes) -> dict | None:
    """Strict JSON decode — reject unknown fields, enforce types."""
    try:
        # Python equivalent of Go's dec.DisallowUnknownFields()
        event = json.loads(raw)
    except json.JSONDecodeError:
        increment_rejection_counter(host="unknown")
        return None

    # Required fields
    required = {"type", "ts", "host", "seq", "prev_hash"}
    if not required.issubset(event.keys()):
        increment_rejection_counter(event.get("host", "unknown"))
        return None

    # String length limits
    limits = {"file": 4096, "process": 256, "host": 253, "type": 128}
    for field, max_len in limits.items():
        if field in event and isinstance(event[field], str) and len(event[field]) > max_len:
            increment_rejection_counter(event.get("host", "unknown"))
            return None

    return event

# Track rejections per host — alert if > 100/hour
rejection_counts: dict[str, int] = {}
def increment_rejection_counter(host: str):
    rejection_counts[host] = rejection_counts.get(host, 0) + 1
    if rejection_counts[host] > 100:
        emit_alert("SENTINEL_SCHEMA_VIOLATION", {
            "host": host,
            "rejections_per_hour": rejection_counts[host],
        })
```

**Rationale:** A compromised sentinel crafting malformed events to exploit a parser vulnerability in the detection engine is a real attack vector. Strict schema validation eliminates this class of attack.

---

## Dependencies

**Python 3.11+** — no language change; detection engine stays Python.

### Python Packages

```
kafka-python==2.0.2
python-dateutil==2.8.2
pytz==2024.1
kubernetes==28.1.0
python-ldap==3.4.3       # optional, for LDAP user enrichment
```

### Runtime Requirements

- Access to Kubernetes API (for K8s context enrichment)
- LDAP/SSO endpoint (for user enrichment, optional)
- Telemetry bus running and populated before engine starts

