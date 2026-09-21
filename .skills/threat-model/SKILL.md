---
name: threat-model
description: "Use this skill for threat modeling, attack scenario analysis, red-team simulation, and understanding the limitations of the canary system. Covers: attacker capability assumptions, attack scenario matrix, detection coverage gaps, red-team safe simulation procedures, and scalability considerations."
depends_on: []
---

# Threat Model

## Overview

This document defines the threat model for the canary detection system: what attacker capabilities are assumed, what attack scenarios are covered (and how), and what the system cannot detect. Read this before designing new canary placements or tuning detection rules.

---

## Attacker Capability Assumptions

The system is designed under these worst-case assumptions:

| Capability | Assumed? | Notes |
|------------|----------|-------|
| Root / sudo on one or more Linux nodes | Yes | Most serious realistic scenario |
| Kubernetes RBAC role (non-cluster-admin) | Yes | Compromised service account |
| Database read access (non-superuser) | Yes | Compromised app credentials |
| Ability to read local logs | Yes | Has root → can read /var/log |
| Ability to modify/delete local logs | Yes | Has root → can truncate files |
| Ability to inspect running processes | Yes | /proc, ps, lsof all accessible |
| Ability to list running eBPF programs | Yes | bpftool accessible to root |
| Knowledge that a detection system exists | Maybe | System designed to survive this |
| Knowledge of exact canary file locations | No | Attacker should not be able to derive these |
| Cluster-admin Kubernetes access | No | If this is compromised, treat as full breach |
| TPM modification or physical access | No | Out of scope for software-layer defense |
| Network-layer interception (BGP, MITM) | No | Handled by TLS/mTLS at transport layer |

---

## What the System Detects Well

These scenarios are detected with high confidence (Tier 1 rules):

### 1. Credential Harvesting via File Access

**Scenario:** Attacker with shell access runs `grep -r password /home` or `find / -name "*.env"`.

**Detection:** eBPF `vfs_read` kprobe fires the moment any canary file's FD is opened. Event is signed and shipped to remote log within milliseconds. Alert fires before attacker can complete the grep.

**Confidence:** Very high. Requires the attacker to know exactly which files are canaries and avoid them — which requires knowledge they shouldn't have.

### 2. Database Exfiltration via Direct Query

**Scenario:** Attacker with stolen app credentials runs `SELECT * FROM _system_config.secrets`.

**Detection:** PostgreSQL trigger fires synchronously inside the transaction. Even if the query is rolled back or errors, the trigger already fired. `pg_notify` reaches the sentinel listener within 1 second.

**Confidence:** High. The only bypass is running as a superuser and disabling triggers — which requires superuser credentials.

### 3. Kubernetes PVC Snapshot Exfiltration

**Scenario:** Attacker creates a `VolumeSnapshot` of a production PVC to exfiltrate its contents via a controlled environment.

**Detection:** K8s API watch fires on `VolumeSnapshot` creation. If the requesting service account is not in the allowlist, immediate alert. If the canary PVC is the snapshot source, always alerts regardless of allowlist.

**Confidence:** High. Requires exploiting cluster-admin or a privileged service account.

### 4. Filesystem Enumeration (Automated Tools)

**Scenario:** Attacker runs `find / -type f -name "*.key" -o -name "*.pem"` or similar.

**Detection:** Sliding window counter detects 5+ canary file stat() calls within 30 seconds. Fires as Tier 2 bulk enumeration alert.

**Confidence:** High for automated tools. Moderate for patient, manual enumeration.

### 5. Attempt to Kill the Sentinel

**Scenario:** Attacker discovers sentinel processes and sends `kill -9`.

**Detection:** eBPF probe on `kill()` syscall targeting sentinel PIDs fires before the signal is delivered. The mutual watchdog fires an out-of-band alert if the process disappears. The kill attempt itself is recorded in the remote log.

**Additional defense:** Even `systemctl stop` or `SIGTERM` now triggers an `UNAUTHORIZED_SHUTDOWN` P1 alert unless the operator has presented a valid, Ed25519-signed Authorization Ticket first. An attacker with root access but without the offline maintenance signing key **cannot** gracefully shut down the sentinel without triggering a P1 alert.

**Confidence:** Very high. Even if the attacker kills sentinel-a, sentinel-b fires the alert and vice versa. The cryptographic authorization ticket requirement means `root` alone is insufficient to silence the system.

---

## What the System Detects with Moderate Confidence

### 6. Log Tampering

**Scenario:** Attacker truncates `/var/log/canary/sentinel.log` or deletes event files.

**Detection:** Remote log receives events before local logs are written (Vector ships first). The log integrity verifier detects sequence gaps in the Merkle chain. A gap in the remote log where there should be events is itself an alert signal.

**Gap:** If the attacker can somehow interrupt the remote shipping (e.g., network partition + local log deletion simultaneously), events in transit may be lost. The network partition itself is detectable if it persists.

**Confidence:** Moderate. The window between event generation and remote receipt (typically < 1 second) is the attack surface.

### 7. Gradual / Low-Frequency Reconnaissance

**Scenario:** A patient attacker accesses one canary file per week over months.

**Detection:** Tier 1 — any single canary file access fires regardless of frequency.

**Gap:** If canary coverage is sparse and the attacker avoids every canary by luck, they would not be detected until they hit one.

**Mitigation:** Dense canary coverage. If canaries make up 5–10% of files in sensitive directories, even a randomly browsing attacker will hit one within a few reads.

---

## What the System Does NOT Detect

Be explicit about coverage gaps:

### 8. Side-Channel Exfiltration

**Scenario:** Attacker exfiltrates data via covert channel (DNS tunneling, steganography, optical, acoustic).

**Detection:** Not detected unless the attacker first accesses a canary file to know what to exfiltrate.

### 9. Data Exfiltration from Real (Non-Canary) Files

**Scenario:** Attacker reads only real credentials that happen to not be canary files.

**Detection:** Not detected. The canary system creates coverage probability, not complete coverage. A sophisticated attacker who knows exactly which files are real and which are canaries could avoid detection.

**Mitigation:** Combine with DLP (data loss prevention) tooling for coverage of non-canary data.

### 10. Compromise of the Remote Log Infrastructure

**Scenario:** Attacker compromises the remote log store (S3, Loki) and deletes records.

**Detection:** S3 Object Lock (Governance mode) prevents deletion during retention period even by the bucket owner. Loki with write-only tokens prevents reads and deletes from the sentinel's credential. If someone with admin access to the log store deletes records, only a separate out-of-band integrity check would detect it.

### 11. Supply Chain Attack on Canary Binaries

**Scenario:** Attacker compromises the canary-deployer binary or Tetragon image before deployment.

**Detection:** Not detected by the runtime system. Requires separate supply chain security measures (image signing with cosign, binary integrity with dm-verity, SBOM verification).

---

## Red-Team Simulation Procedures

Run these exercises quarterly to verify the system works end-to-end:

### Safe Red-Team Protocol

```
1. Brief the detection team: "Red team exercise starting at TIME — alert if you see it"
2. Use a dedicated red-team user account (pre-created, tracked separately)
3. Do NOT add the red-team account to any suppression lists
4. After exercise, debrief: what was detected? What wasn't? How long to alert?
5. Document findings and tune accordingly
```

### Exercise 1: File Canary Access

```bash
# Run as a non-privileged test user
# Expected: P1 alert within 60 seconds

RED_TEAM_USER=redteam-$(date +%Y%m%d)
useradd -m -s /bin/bash $RED_TEAM_USER

su - $RED_TEAM_USER -c "cat $(jq -r '.canaries[0].path' /opt/canary/config/canary-map.json)"

# Measure: time from access to PagerDuty notification
# Target: < 60 seconds
# Acceptable: < 120 seconds
# Fail: > 300 seconds or no alert
```

### Exercise 2: Bulk Enumeration Simulation

```bash
# Simulate find / -name "*.env" behavior
su - $RED_TEAM_USER -c "
  for path in $(jq -r '.canaries[].path' /opt/canary/config/canary-map.json | head -10); do
    stat $path 2>/dev/null
    sleep 1
  done
"
# Expected: BULK_CANARY_FILE_READ alert within 35 seconds of 5th stat()
```

### Exercise 3: Database Canary Access

```bash
# Connect as a low-privilege app user and query a canary table
psql -U app_readonly -c "SELECT * FROM _system_config.secrets LIMIT 1;" 2>&1
# Expected: permission denied (role check) AND DB_CANARY_ACCESS alert fires

# Test as DBA user (more privileged — should definitely alert)
psql -U dba_user -c "SELECT COUNT(*) FROM _financial_archive.transactions;"
# Expected: query succeeds AND DB_CANARY_ACCESS alert fires
```

### Exercise 4: Sentinel Kill Attempt

```bash
# CAUTION: This will trigger a P1 alert. Brief on-call team first.
# Expected behavior: sentinel-b alerts, sentinel-a restarts automatically

# Send SIGTERM to sentinel-a (non-destructive but triggers watchdog)
kill -TERM $(cat /run/canary/sentinel-a.pid)

# Verify: sentinel-a restarts within 5 seconds
# Verify: SENTINEL_KILL_ATTEMPT alert fires
# Verify: sentinel-b continues running throughout
```

### Exercise 5: Log Tampering Attempt

```bash
# Attempt to truncate local log (out-of-band alert should fire)
truncate -s 0 /opt/sentinel/logs/local-chain.log

# Expected:
# - Remote log continues receiving events (tampering was local only)
# - Log integrity verifier detects Merkle chain gap within 60 seconds
# - LOG_CHAIN_BREAK alert fires
```

---

## Scalability Considerations

### Large Node Counts (100+ Servers)

- eBPF probes run per-node — horizontal scaling is native. No central bottleneck for event collection.
- Vector agents run per-node and batch to Kafka. Kafka scales to millions of events/second with appropriate partition counts.
- Canary file deployer should run via a fleet management tool (Ansible Tower, Salt) to avoid per-host SSH at scale.
- The detection engine is the scaling bottleneck. Run multiple instances with Kafka consumer group partitioning.

### Large Kubernetes Clusters (100+ Nodes)

- DaemonSet naturally scales with node count.
- Falco/Tetragon per-node overhead: ~50–100MB RAM, 1–3% CPU on busy nodes.
- The K8s API-level operator has one instance per cluster — it watches API events, not per-node events. CPU/RAM is low (<50MB).
- VolumeSnapshot allowlist enforcement must account for all backup systems across all namespaces.

### Large Databases (TB-scale)

- Canary tables are small (thousands of rows). No performance impact from the tables themselves.
- `pg_audit` logging volume can be significant. Use `pgaudit.log_relation = off` and limit auditing to canary schemas via row-level settings:
  ```sql
  ALTER TABLE _system_config.secrets SET (autovacuum_enabled = false);
  -- pg_audit per-object auditing:
  SECURITY LABEL FOR pgaudit ON TABLE _system_config.secrets IS 'OBJECT';
  ```
- The NOTIFY/LISTEN mechanism is zero-cost when idle and low-cost when firing.

---

## Maintenance Windows

All lifecycle operations (deployment, redeployment, shutdown, killswitch) require a cryptographically signed **Authorization Ticket**. See `sentinel-daemon/SKILL.md` > "Cryptographic Authorization Tickets" for the full procedure.

Some legitimate operations will trigger Tier 2 (behavioral) alerts if not handled:

| Operation | Affected Rule | Mitigation |
|-----------|--------------|------------|
| Database schema migration | DB_SCHEMA_ENUM | Add migration SA to suppression with time window |
| Backup job run | BULK_CANARY_FILE_READ (stat only) | Verify backup agent is in stat_exclusions |
| Security audit / pentest | Multiple | Pre-approve in suppression list with exact time window |
| Canary file rotation | CANARY_FILE_METADATA_CHANGE | Canary-cleaner binary in stat_exclusions |
| Velero backup | HIGH_VOLUME_PVC_READ | Velero SA in PVC allowlist |
| **Sentinel redeployment** | SENTINEL_DOWN, VERIFIER_ANOMALY | **Generate a signed REDEPLOY ticket** |
| **Sentinel shutdown** | UNAUTHORIZED_SHUTDOWN | **Generate a signed SHUTDOWN ticket** (temporary) |
| **Sentinel decommission** | SENTINEL_SILENT, SENTINEL_DOWN | **Generate a signed DEREGISTER ticket** (permanent) |
| **Kill switch activation** | SENTINEL_DEGRADED | **Generate a signed KILLSWITCH_ACTIVATE ticket** |

**Tier 1 rules are never suppressed during maintenance windows.** If a real attacker times their attack to coincide with a maintenance window, Tier 1 detects them regardless.
