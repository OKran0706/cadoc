---
name: canary-system
description: "Master skill for the tamper-resistant canary-based detection system. Use this file to understand the full project structure and navigate to the correct sub-skill. Covers: Linux file canaries, Kubernetes PVC monitoring, privileged sentinel daemon, database canary mesh, telemetry bus, detection engine, alerting pipeline, deployment, and threat model."
version: 1.0.0
environment: Linux (Ubuntu 20.04+), Kubernetes 1.26+, PostgreSQL 14+ / MySQL 8+
---

# Tamper-Resistant Canary Detection System — Master Skill

## Project Purpose

This system detects unauthorized access in adversarial environments (enterprise, government, critical infrastructure) by planting high-fidelity decoy assets across filesystems, Kubernetes PVCs, and databases. Any interaction with a canary asset is an unambiguous, high-confidence signal of intrusion or internal threat.

## Core Design Principles

- **Asymmetric cost**: cheap to deploy, extremely expensive to evade silently.
- **Defense in depth**: each layer detects independently; compromise of one layer does not blind the others.
- **Remote-first integrity**: all logs are signed and shipped offsite before any local action is taken.
- **Least surprise for attackers**: canaries are indistinguishable from real assets.

---

## Project Structure

```
src/
├── sentinel/              (Go module — dual-process daemon)
├── canary-deployer/       (Go module — file generation + rotation)
├── chain-verifier/        (Go module — Merkle chain verification)
├── pvc-operator/          (Go module — controller-runtime K8s operator)
├── detection-engine/      (Python 3.11+ — Kafka consumer, rule engine)
├── alert-response/        (Python 3.11+ — PagerDuty, Slack, auto-response)
└── db-canary/             (Python 3.11+ — pg LISTEN/NOTIFY, MySQL watcher)

.skills/
├── SKILL.md                    ← You are here (master navigation)
├── file-canary-engine/
│   └── SKILL.md                ← Decoy file generation & inotify/eBPF monitoring
├── pvc-watchdog/
│   └── SKILL.md                ← Kubernetes PVC & VolumeSnapshot monitoring
├── sentinel-daemon/
│   └── SKILL.md                ← Hardened root-level monitoring process
├── db-canary-mesh/
│   └── SKILL.md                ← PostgreSQL/MySQL decoy tables, rows, triggers
├── telemetry-bus/
│   └── SKILL.md                ← Signed event pipeline (Vector → Kafka → remote store)
├── detection-engine/
│   └── SKILL.md                ← Rule engine + behavioral anomaly scoring
├── alert-response/
│   └── SKILL.md                ← PagerDuty/Slack/SIEM + automated response actions
├── deployment/
│   └── SKILL.md                ← Ansible roles, Helm charts, bootstrapping order
└── threat-model/
    └── SKILL.md                ← Threat model, attack scenarios, limitations
```

---

## Sub-Skill Navigation

| Task                                      | Read this SKILL.md                              |
|-------------------------------------------|-------------------------------------------------|
| Generate or update canary files on Linux  | `.skills/file-canary-engine/SKILL.md`           |
| Monitor Kubernetes volumes / PVCs         | `.skills/pvc-watchdog/SKILL.md`                 |
| Configure or harden the sentinel daemon   | `.skills/sentinel-daemon/SKILL.md`              |
| Add/remove DB canary tables or rows       | `.skills/db-canary-mesh/SKILL.md`               |
| Configure log signing and remote shipping | `.skills/telemetry-bus/SKILL.md`                |
| Tune detection rules or scoring           | `.skills/detection-engine/SKILL.md`             |
| Set up alerting or automated response     | `.skills/alert-response/SKILL.md`               |
| Deploy the full system (fresh or update)  | `.skills/deployment/SKILL.md`                   |
| Review threat model or run red-team sim   | `.skills/threat-model/SKILL.md`                 |

---

## Layer Interaction Map

```
Monitored Assets (Linux servers · K8s PVCs · Databases)
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│  Canary Deployment Layer                                  │
│  file-canary-engine  │  pvc-watchdog  │  db-canary-mesh  │
└──────────────────────────────────────────────────────────┘
        │  raw access events (eBPF / inotify / pg_audit)
        ▼
┌──────────────────────────────────────────────────────────┐
│  Hardened Sentinel Daemon  (root, tamper-resistant)       │
│  Enriches events · Signs with Ed25519 · Merkle-chains    │
└──────────────────────────────────────────────────────────┘
        │  signed, chained events
        ▼
┌──────────────────────────────────────────────────────────┐
│  Signed Telemetry Bus                                     │
│  Vector → Kafka → S3 Object Lock / remote Loki           │
└──────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────┐    ┌──────────────────────────┐
│  Detection Engine     │    │  Log Integrity Verifier  │
│  Rules + Behavioral   │    │  Merkle gap detection    │
└───────────────────────┘    └──────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│  Alert & Response                                         │
│  PagerDuty · Slack · SIEM · auto-quarantine              │
└──────────────────────────────────────────────────────────┘
```

---

## Global Prerequisites

```bash
# Minimum kernel version (for eBPF + lockdown support)
uname -r   # Must be >= 5.8

# Required packages (Debian/Ubuntu)
apt-get install -y \
  bpfcc-tools \
  inotify-tools \
  auditd \
  tpm2-tools \
  rsyslog-gnutls \
  postgresql-14 \
  libpq-dev

# Kubernetes minimum version
kubectl version --short   # Must be >= 1.26 (for PVC VolumeSnapshot GA)

# Enable kernel lockdown (add to /etc/default/grub GRUB_CMDLINE_LINUX)
# lockdown=integrity lsm=lockdown,yama,apparmor
```

## Global Environment Variables

```bash
# Set these in /etc/environment or a secrets manager (Vault/AWS SSM)
CANARY_REMOTE_LOG_ENDPOINT="https://logs.internal/ingest"
CANARY_SIGNING_KEY_PATH="/etc/canary/keys/ed25519.priv"   # or TPM handle
CANARY_ALERT_WEBHOOK="https://hooks.pagerduty.com/..."
CANARY_DB_CONN="postgres://canary_monitor:$PASS@localhost/canarydb"
CANARY_KAFKA_BROKERS="kafka-0:9092,kafka-1:9092"
CANARY_S3_BUCKET="canary-logs-immutable"
```

## Deployment Order (Critical)

Always deploy components in this order to avoid detection gaps:

1. `sentinel-daemon` — must be running before any canaries are planted
2. `telemetry-bus` — remote log sink must be ready before sentinel emits events
3. `file-canary-engine` — plant files after sentinel is watching
4. `pvc-watchdog` — deploy DaemonSet after sentinel confirms healthy
5. `db-canary-mesh` — install triggers and decoy tables last
6. `detection-engine` — connect to telemetry bus
7. `alert-response` — validate end-to-end with a test canary access

---

## Technology Stack

| Component             | Language        | Primary Tool              | Fallback / Alternative        |
|-----------------------|-----------------|---------------------------|-------------------------------|
| Sentinel daemon       | Go              | Static binary (eBPF)      | –                             |
| Canary deployer       | Go              | Static binary             | –                             |
| Chain verifier        | Go              | Static binary             | –                             |
| PVC watchdog operator | Go (ctrl-runtime) | Kubernetes operator     | –                             |
| Detection engine      | Python 3.11+    | Kafka consumer            | –                             |
| Alert & response      | Python 3.11+    | PagerDuty + Slack         | Opsgenie + MS Teams           |
| DB canary listener    | Python 3.11+    | psycopg2 + tailer         | –                             |
| Kernel monitoring     | YAML            | Tetragon (eBPF)           | Falco + inotifywait           |
| Log signing           | –               | Ed25519 (stdlib crypto)   | GPG with subkeys              |
| Log transport         | YAML            | Vector → Kafka            | rsyslog (TLS) → Elasticsearch|
| Remote log store      | –               | S3 Object Lock            | Loki (write-only token)       |
| DB audit              | SQL             | pg_audit (PostgreSQL)     | MySQL general_log sidecar     |
| Secrets               | –               | HashiCorp Vault           | AWS Secrets Manager           |
| Deployment            | YAML            | Ansible + Helm            | Terraform + Kustomize         |

---

## Language Decision Rationale

### Why Go for sentinel-daemon, canary-deployer, chain-verifier

- **Single static binary**: Go compiles to a fully static binary with no runtime dependencies. This is critical for tamper-resistant fleet distribution — there is no Python interpreter, no pip install, no virtualenv to compromise on target hosts.
- **eBPF via cilium/ebpf**: The Go `cilium/ebpf` library provides first-class, pure-Go eBPF program loading and map access — no dependency on BCC, LLVM, or Python bindings on the target host.
- **Goroutine concurrency**: The sentinel's dual-process watchdog, heartbeat loop, event signing pipeline, and Kafka producer all run concurrently. Goroutines with channels are idiomatic and efficient for this workload.
- **Startup speed**: Go binaries start in milliseconds, important for a security daemon that systemd may need to restart quickly after a kill attempt.

### Why Go for pvc-operator (controller-runtime)

- **Kubernetes controllers are idiomatic Go**: The `sigs.k8s.io/controller-runtime` framework handles reconciliation loops, leader election, watch/cache, and rate-limited retries natively. Writing a K8s operator in Python would mean reimplementing all of these primitives.
- **Client-go maturity**: The official Kubernetes Go client is the reference implementation. Python client-kubernetes lags behind in feature parity.

### Why Python for detection-engine

- **Rule complexity benefits from readability**: Security engineers who tune detection rules need to read and modify rule logic without recompiling. Python's expressiveness makes rule definitions accessible.
- **kafka-python and psycopg2 are mature**: The detection engine is I/O-bound (Kafka consumer, DB queries), not CPU-bound. Python's library ecosystem is well-suited.
- **Hot-reload**: Rule YAML files can be reloaded without restarting the process. In Go, this would require embedding a scripting engine or recompiling.

### Why Python for alert-response and db-canary

- **Network-bound workloads**: PagerDuty, Slack, and SIEM HTTP calls are network-bound. Python `requests` is more than sufficient; Go's performance advantage is irrelevant here.
- **psycopg2 PostgreSQL LISTEN/NOTIFY**: The Python `psycopg2` library has robust, well-documented async notification support. The Go `pgx` library is also good, but the DB listener's coupling to the detection-engine (also Python) justifies keeping them in the same language.
- **SDK quality**: PagerDuty and Slack Python SDKs/examples are high quality and widely used.

---

## Quick Validation Checklist

Run after any deployment or configuration change:

```bash
# 1. Verify sentinel is running and both watchdog processes are alive
systemctl status canary-sentinel-a canary-sentinel-b

# 2. Trigger a test canary file access and confirm alert fires within 5s
cat /opt/canary/test/.canary_trigger_test && sleep 5
grep "CANARY_ACCESS" /var/log/canary/sentinel.log

# 3. Verify Merkle chain is unbroken
canary-verifier --check-chain --last 1000

# 4. Confirm remote log is receiving events
canary-verifier --remote-check --last-5-minutes

# 5. Verify DB canary trigger fires
psql -U canary_test -c "SELECT 1 FROM _system_config LIMIT 1;"
grep "DB_CANARY_ACCESS" /var/log/canary/db.log
```
