---
name: telemetry-bus
description: "Use this skill for configuring the signed event pipeline. Covers: Vector configuration, Kafka topic setup, TLS/mTLS, Ed25519 signature verification on ingest, S3 Object Lock / Loki remote storage, Merkle chain gap detection, and log integrity verification. The telemetry bus must be running before the sentinel daemon starts."
depends_on: []
---

# Signed Telemetry Bus

## Overview

The telemetry bus is the transport layer between the sentinel daemon and the remote immutable log store. Every event transiting this bus is:
- Ed25519-signed (by the sentinel at source)
- Merkle-chained (each event includes the SHA-256 of the previous)
- Delivered over TLS with mutual authentication
- Written to an append-only, tamper-evident remote store

The bus must be running and reachable **before** the sentinel daemon starts. If the bus is unreachable, the sentinel should fail to start (fail closed, not open).

---

## Architecture

```
Sentinel Daemon
    │  Ed25519-signed JSON events
    ▼
Vector (local agent, per-node)
    │  TLS + mTLS
    ▼
Kafka (cluster, retained forever)
    │
    ├──→ Detection Engine (consumer group: detection)
    ├──→ Log Integrity Verifier (consumer group: verifier)
    └──→ S3 Object Lock Sink / Loki (consumer group: archive)
```

---

## Kafka Setup

### Topic Configuration

```bash
# Create the canary-events topic
# - Infinite retention (set.retention.ms = -1)
# - 3 replicas for durability
# - Compact + delete cleanup (keep all events, compact old canary IDs)

kafka-topics.sh --create \
  --bootstrap-server kafka-0:9092 \
  --topic canary-events \
  --partitions 6 \
  --replication-factor 3 \
  --config retention.ms=-1 \
  --config cleanup.policy=delete \
  --config min.insync.replicas=2

# Create a separate topic for sentinel heartbeats (shorter retention)
kafka-topics.sh --create \
  --bootstrap-server kafka-0:9092 \
  --topic canary-heartbeats \
  --partitions 3 \
  --replication-factor 3 \
  --config retention.ms=86400000  # 24 hours
```

### Kafka ACLs (Write-Only for Sentinel)

The sentinel should only be able to PRODUCE. It must never be able to consume or delete:

```bash
# Sentinel producer ACL
kafka-acls.sh --add \
  --bootstrap-server kafka-0:9092 \
  --allow-principal User:sentinel \
  --operation Write \
  --topic canary-events

# Detection engine consumer ACL
kafka-acls.sh --add \
  --bootstrap-server kafka-0:9092 \
  --allow-principal User:detection-engine \
  --operation Read \
  --topic canary-events \
  --group detection

# Explicitly deny Delete for all non-admin principals
kafka-acls.sh --add \
  --bootstrap-server kafka-0:9092 \
  --deny-principal User:* \
  --operation Delete \
  --topic canary-events
```

---

## Vector Configuration (Local Agent)

Vector runs on each node as a systemd service. It receives events from the sentinel via a local Unix socket, verifies the Ed25519 signature, and forwards to Kafka.

```yaml
# /etc/vector/vector.yaml

sources:
  sentinel_unix:
    type: socket
    path: /run/canary/vector.sock
    mode: unix_stream
    decoding:
      codec: json

transforms:
  verify_signature:
    type: remap
    inputs: [sentinel_unix]
    source: |
      # Verify Ed25519 signature before forwarding
      # (Vector WASM transform — see custom plugin below)
      payload = .payload
      sig = .signature
      key_id = .key_id

      # Load trusted public key for this host
      pubkey = get_env_var!("CANARY_SIGNING_PUBKEY_B64")

      verified = verify_ed25519_signature(payload, sig, pubkey)
      if !verified {
        log("Signature verification failed — possible tampering", level: "error")
        abort  # Drop the event and alert
      }

      # Add verification metadata
      .verified = true
      .received_at = now()
      .node = get_hostname!()

  add_sequence:
    type: remap
    inputs: [verify_signature]
    source: |
      # Add per-node sequence number for gap detection
      .node_seq = get_counter!("event_seq")
      increment_counter!("event_seq")

sinks:
  kafka_canary:
    type: kafka
    inputs: [add_sequence]
    bootstrap_servers: "kafka-0:9092,kafka-1:9092,kafka-2:9092"
    topic: "canary-events"
    key_field: ".host"
    encoding:
      codec: json
    tls:
      enabled: true
      ca_file: /etc/canary/tls/ca.crt
      crt_file: /etc/canary/tls/vector-client.crt
      key_file: /etc/canary/tls/vector-client.key
    # Dead letter queue for failed deliveries (local, encrypted)
    buffer:
      type: disk
      max_size: 268435456  # 256MB
      when_full: block     # Block sentinel rather than drop events

  # Also ship to remote syslog as backup path
  remote_syslog:
    type: syslog
    inputs: [add_sequence]
    address: "logs.internal:6514"
    mode: tcp
    tls:
      enabled: true
      ca_file: /etc/canary/tls/ca.crt
      crt_file: /etc/canary/tls/vector-client.crt
      key_file: /etc/canary/tls/vector-client.key
    encoding:
      codec: json
```

---

## Remote Storage: S3 Object Lock

The canonical immutable store. Events are written here by a Kafka consumer. Object Lock with Governance mode prevents deletion even by the bucket owner during the retention period.

```bash
# Create S3 bucket with Object Lock
aws s3api create-bucket \
  --bucket canary-logs-immutable \
  --region us-east-1 \
  --object-lock-enabled-for-bucket

# Set default retention (3 years)
aws s3api put-object-lock-configuration \
  --bucket canary-logs-immutable \
  --object-lock-configuration '{
    "ObjectLockEnabled": "Enabled",
    "Rule": {
      "DefaultRetention": {
        "Mode": "GOVERNANCE",
        "Days": 1095
      }
    }
  }'

# Enable versioning (required for Object Lock)
aws s3api put-bucket-versioning \
  --bucket canary-logs-immutable \
  --versioning-configuration Status=Enabled

# Restrict S3 bucket policy: only the Kafka consumer can write; nobody can delete
aws s3api put-bucket-policy \
  --bucket canary-logs-immutable \
  --policy '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "AllowKafkaConsumerWrite",
        "Effect": "Allow",
        "Principal": {"AWS": "arn:aws:iam::ACCOUNT_ID:role/canary-kafka-consumer"},
        "Action": ["s3:PutObject"],
        "Resource": "arn:aws:s3:::canary-logs-immutable/*"
      },
      {
        "Sid": "DenyAllDeletes",
        "Effect": "Deny",
        "Principal": "*",
        "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion"],
        "Resource": "arn:aws:s3:::canary-logs-immutable/*"
      }
    ]
  }'
```

### Kafka → S3 Consumer (Vector)

```yaml
# /etc/vector/s3-sink.yaml  (runs on dedicated archiver node)

sources:
  kafka_canary:
    type: kafka
    bootstrap_servers: "kafka-0:9092,kafka-1:9092"
    topics: ["canary-events"]
    group_id: "archive"
    tls:
      enabled: true
      ca_file: /etc/canary/tls/ca.crt
      crt_file: /etc/canary/tls/archiver.crt
      key_file: /etc/canary/tls/archiver.key

sinks:
  s3_immutable:
    type: aws_s3
    inputs: [kafka_canary]
    bucket: canary-logs-immutable
    region: us-east-1
    key_prefix: "events/year=%Y/month=%m/day=%d/hour=%H/"
    encoding:
      codec: ndjson
    compression: gzip
    batch:
      max_bytes: 10485760   # 10MB per file
      timeout_secs: 300     # Flush every 5 minutes
```

---

## Remote Storage: Loki (Self-Hosted Alternative)

```yaml
# Loki configuration — write-only token provisioned via Vault TTL
# Token expires every 24h; sentinel fetches a new one on startup

# In Vector config:
sinks:
  loki:
    type: loki
    inputs: [add_sequence]
    endpoint: "https://loki.internal"
    auth:
      strategy: bearer
      token: "${LOKI_WRITE_TOKEN}"  # Short-lived, write-only
    labels:
      host: "{{ .host }}"
      alert_type: "{{ .type }}"
    encoding:
      codec: json
    tls:
      ca_file: /etc/canary/tls/ca.crt
```

---

## Merkle Chain Gap Detection

The log integrity verifier continuously reads from Kafka and checks that:
1. Sequence numbers are contiguous per host (no gaps)
2. Each event's `prev_hash` matches the SHA-256 of the previous event's payload
3. Signatures verify against the registered public key for each host

**Language: Go** — compiled to a single static binary.

```
module github.com/your-org/canary/chain-verifier

go 1.26

require (
    github.com/segmentio/kafka-go v0.4.47
    golang.org/x/crypto            v0.21.0
)
```

```go
// /opt/canary/bin/chain-verifier (Go)

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"

	"github.com/segmentio/kafka-go"
)

type ChainVerifier struct {
	publicKeys map[string]ed25519.PublicKey // keyID → public key
	lastHash   map[string]string           // host → last verified hash
	lastSeq    map[string]int64            // host → last sequence number
}

func NewChainVerifier(publicKeys map[string]ed25519.PublicKey) *ChainVerifier {
	return &ChainVerifier{
		publicKeys: publicKeys,
		lastHash:   make(map[string]string),
		lastSeq:    make(map[string]int64),
	}
}

func (cv *ChainVerifier) VerifyChain(ctx context.Context, reader *kafka.Reader) {
	for {
		msg, err := reader.ReadMessage(ctx)
		if err != nil {
			log.Printf("Read error: %v", err)
			continue
		}

		var envelope struct {
			Payload   string `json:"payload"`
			Signature string `json:"signature"`
			KeyID     string `json:"key_id"`
		}
		if err := json.Unmarshal(msg.Value, &envelope); err != nil {
			continue
		}

		// 1. Verify Ed25519 signature
		pubKey, ok := cv.publicKeys[envelope.KeyID]
		if ok {
			sigBytes, _ := hex.DecodeString(envelope.Signature)
			if !ed25519.Verify(pubKey, []byte(envelope.Payload), sigBytes) {
				cv.emitAlert("SIGNATURE_VERIFICATION_FAILED", "", envelope.KeyID)
				continue
			}
		}

		// 2. Parse inner payload
		var inner struct {
			Host     string `json:"host"`
			Seq      int64  `json:"seq"`
			PrevHash string `json:"prev_hash"`
		}
		if err := json.Unmarshal([]byte(envelope.Payload), &inner); err != nil {
			continue
		}

		host := inner.Host
		hash := sha256.Sum256([]byte(envelope.Payload))
		eventHash := hex.EncodeToString(hash[:])

		// 3. Check sequence continuity
		if lastSeq, exists := cv.lastSeq[host]; exists && inner.Seq != lastSeq+1 {
			cv.emitAlert("SEQUENCE_GAP", host, fmt.Sprintf(
				"expected=%d got=%d gap=%d", lastSeq+1, inner.Seq, inner.Seq-lastSeq-1,
			))
		}

		// 4. Check Merkle chain
		if lastHash, exists := cv.lastHash[host]; exists && inner.PrevHash != lastHash {
			cv.emitAlert("MERKLE_CHAIN_BREAK", host, fmt.Sprintf(
				"expected_prev=%s claimed_prev=%s seq=%d", lastHash, inner.PrevHash, inner.Seq,
			))
		}

		cv.lastSeq[host] = inner.Seq
		cv.lastHash[host] = eventHash
	}
}

func (cv *ChainVerifier) emitAlert(alertType, host, detail string) {
	log.Printf("ALERT: type=%s host=%s detail=%s", alertType, host, detail)
	// Also write alert to Kafka canary-events topic
}
```

---

## TLS Certificate Management

```bash
# Generate CA (done once; key stored in HSM or offline)
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -new -x509 -days 3650 -key ca.key -out ca.crt \
  -subj "/CN=Canary Internal CA/O=Canary System"

# Generate per-component client certs (sentinel, vector, archiver)
for component in sentinel vector detection-engine archiver; do
  openssl ecparam -name prime256v1 -genkey -noout -out ${component}.key
  openssl req -new -key ${component}.key -out ${component}.csr \
    -subj "/CN=${component}/O=Canary System"
  openssl x509 -req -days 365 -in ${component}.csr \
    -CA ca.crt -CAkey ca.key -CAcreateserial -out ${component}.crt
done

# Rotate certs annually; automate with cert-manager in Kubernetes
```

---

## Health Check

```bash
# Verify Vector is forwarding to Kafka
vector top  # Shows events/sec per component

# Verify Kafka topic has recent messages
kafkacat -b kafka-0:9092 -t canary-events -C -o -1 -c 1 \
  | jq '.ts' # Should be within last 30 seconds (sentinel heartbeats)

# Verify chain integrity for last 1000 events
/opt/canary/bin/chain-verifier --last 1000 --report

# Verify S3 archiver is writing
aws s3 ls s3://canary-logs-immutable/events/ --recursive | sort | tail -5
```

---

## Independent Verification Layer

Deploy a separate, minimal verification agent on each host that is **completely independent** of the sentinel. This means an attacker must compromise **two** independent processes (sentinel AND verifier) to silence the host completely.

### Design Principles

The verifier uses **no eBPF, no Kafka, no shared infrastructure** with the sentinel — completely different code path:

| Property | Sentinel | Verifier |
|---|---|---|
| Binary | `/opt/sentinel/bin/sentinel-a` | `/opt/canary/bin/canary-verify` |
| User | `root` | `canary-verify` (unprivileged) |
| Capabilities | `CAP_NET_ADMIN` (runtime) | **None** |
| Transport | Kafka (TLS) | Direct HTTP POST (webhook) |
| Code sharing | None | **Separate binary, no shared code** |
| Checks frequency | Continuous event stream | Every 60 seconds |

### Checks Performed (every 60 seconds)

| # | Check | Method |
|---|---|---|
| 1 | `sentinel-a` is running | Read `/proc/<pid>/status` |
| 2 | `sentinel-b` is running | Read `/proc/<pid>/status` |
| 3 | Tetragon is running and has canary policy loaded | `tetra status`, check policy list |
| 4 | Local Vector agent is running | Read `/proc/<pid>/status` |

### Heartbeat and Anomaly Events

On success, the verifier posts a `VERIFIER_HEARTBEAT` to the remote webhook **directly** (bypasses Kafka entirely — different path from sentinel):

```json
{
  "type": "VERIFIER_HEARTBEAT",
  "host": "node-7",
  "ts": "2026-03-18T02:55:00Z",
  "checks": {
    "sentinel_a": "running",
    "sentinel_b": "running",
    "tetragon": "running",
    "tetragon_policy": "canary-file-access loaded",
    "vector": "running"
  }
}
```

If **any** check fails, posts `VERIFIER_ANOMALY` to the same webhook:

```json
{
  "type": "VERIFIER_ANOMALY",
  "host": "node-7",
  "ts": "2026-03-18T02:55:00Z",
  "failed_checks": ["sentinel_a: not running"],
  "severity": "P1"
}
```

### Detection Engine Integration

The detection engine expects `VERIFIER_HEARTBEAT` from every host every 60 seconds (received via the webhook ingestion path, not Kafka). A **missing** verifier heartbeat is itself an alert:

- Gap > 120s → `VERIFIER_SILENT` (P1)
- The verifier is the last line of defense — its silence is always critical

### Implementation

```go
// /opt/canary/bin/canary-verify — separate binary, runs as canary-verify user
package main

import (
    "fmt"
    "net/http"
    "os"
    "time"
)

func main() {
    webhookURL := os.Getenv("CANARY_VERIFY_WEBHOOK_URL")
    ticker := time.NewTicker(60 * time.Second)
    for range ticker.C {
        checks := runChecks()
        if checks.allPassed() {
            postWebhook(webhookURL, "VERIFIER_HEARTBEAT", checks)
        } else {
            postWebhook(webhookURL, "VERIFIER_ANOMALY", checks)
        }
    }
}

func runChecks() CheckResult {
    return CheckResult{
        SentinelA:       isProcessRunning("sentinel-a"),
        SentinelB:       isProcessRunning("sentinel-b"),
        Tetragon:        isProcessRunning("tetragon"),
        TetragonPolicy:  isTetragonPolicyLoaded("canary-file-access"),
        Vector:          isProcessRunning("vector"),
    }
}

func isProcessRunning(name string) bool {
    // Read /proc — no capabilities needed, just read access
    entries, _ := os.ReadDir("/proc")
    // check /proc/<pid>/comm for matching process name
    // ...
    return false
}
```

### systemd Unit

```ini
# /etc/systemd/system/canary-verify.service
[Service]
ExecStart=/opt/canary/bin/canary-verify
User=canary-verify
Group=canary-verify
# NO capabilities — read /proc and HTTP POST only
CapabilityBoundingSet=
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
```

---

## Dependencies

- Kafka 3.x with TLS and SASL enabled
- Vector 0.36+ (local agent)
- AWS CLI configured (S3 sink) OR Loki 2.x (self-hosted alternative)
- Go 1.26+ (chain verifier build only — no runtime dependency)
- `github.com/segmentio/kafka-go` (chain verifier Kafka consumer)
- `golang.org/x/crypto` (Ed25519 signature verification)
- Certificates provisioned before any component starts

