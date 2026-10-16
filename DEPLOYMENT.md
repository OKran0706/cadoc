# CADOC Deployment Guide

> Environment setup for Integration (INT), UAT, and Production deployments.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Target Hosts / VMs / Pods                │
│                                                             │
│  ┌──────────────┐          ┌──────────────┐                 │
│  │  Sentinel-A   │◄────────│  HashiCorp   │                 │
│  │  (Go binary)  │ Vault   │    Vault     │                 │
│  │               │ API     │              │                 │
│  └──────┬───────┘          └──────────────┘                 │
│         │                                                   │
│         │ Signed Events (Ed25519 + Merkle Chain)            │
│         │                                                   │
│  ┌──────▼───────┐          ┌──────────────┐                 │
│  │    Kafka      │─────────│  Detection   │                 │
│  │  (mTLS/PLAIN) │         │   Engine     │                 │
│  └──────────────┘          └──────────────┘                 │
│                                                             │
│         │ OOB Fallback (HTTP POST, bypasses Kafka)          │
│         ▼                                                   │
│  ┌──────────────┐                                           │
│  │   Webhook /   │                                          │
│  │  PagerDuty    │                                          │
│  └──────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

### Phase 1 Components (Current)

| Component | Description | Status |
|-----------|-------------|--------|
| **Sentinel-A** | Primary event collector, signer, and shipper | ✅ Shipped |
| **Sentinel-B** | Watchdog peer (monitors Sentinel-A) | ⏳ Phase 2 |
| **Vault** | Zero-disk secrets management | ✅ Required |
| **Kafka** | Telemetry ingestion pipeline | ✅ Required |
| **Webhook** | OOB alert receiver (fallback) | ✅ Required |

---

## 1. Integration (INT) Environment

**Purpose:** Developer testing and rapid iteration. Uses Docker Compose with PLAINTEXT Kafka and dev-mode Vault. No TLS, no real secrets.

### Prerequisites
- Docker Desktop (Windows/Mac) or Docker Engine (Linux)
- 4GB RAM minimum

### Setup

```bash
cd test-env/
docker compose up -d --build
```

This single command provisions the full stack:

| Service | Image | Notes |
|---------|-------|-------|
| `canary-vault` | `hashicorp/vault:latest` | Dev mode, root token = `root` |
| `canary-kafka` | `confluentinc/cp-kafka:7.6.1` | PLAINTEXT, KRaft mode, single node |
| `canary-webhook` | Custom Python | Logs all OOB alerts to stdout |
| `canary-sentinel-a` | Custom Go (Alpine) | Connects to Vault + Kafka |
| `canary-vault-init` | `hashicorp/vault:latest` | Seeds test keys, then exits |
| `canary-cert-generator` | `alpine:latest` | Generates test TLS certs, then exits |

### INT Configuration (`test-env/config/sentinel.yaml`)

```yaml
telemetry:
  kafka_brokers:
    - canary-kafka:9092
  topic: canary-events
  tls: false                          # PLAINTEXT for INT only

oob_alert:
  url: http://canary-webhook:8080

watchdog:
  peer_socket: /run/canary/sentinel.sock
  heartbeat_interval_seconds: 10
  alert_threshold_seconds: 30

signing:
  key_source: vault
  vault_path: secret/data/canary/signer
  vault_field: private_key

maintenance:
  vault_path: secret/data/canary/control
  vault_field: auth_pubkey
```

### INT Vault Secrets (Auto-Seeded)

| Path | Field | Value |
|------|-------|-------|
| `secret/canary/signer` | `private_key` | Dummy 128-char hex (64-byte Ed25519 key) |
| `secret/canary/control` | `auth_pubkey` | Dummy 32-char hex (16-byte key ID) |
| `secret/canary/kafka` | `ca_cert`, `client_cert`, `client_key` | Auto-generated self-signed certs |

### Verify INT

```bash
# All services running
docker compose ps

# Sentinel logs — look for "Maintenance ticket verifier initialized"
docker compose logs sentinel-a

# Kafka heartbeats flowing
docker exec canary-kafka kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic canary-events --from-beginning --timeout-ms 10000

# OOB webhook receiving alerts
docker compose logs webhook
```

### Tear Down

```bash
docker compose down --remove-orphans
```

---

## 2. UAT Environment

**Purpose:** Pre-production validation with TLS-enabled Kafka, dedicated Vault instance, and realistic network topology. Should mirror production as closely as possible.

### Infrastructure Requirements

| Component | Recommended Setup |
|-----------|-------------------|
| **Vault** | Dedicated VM or managed HashiCorp Cloud, HA mode, auto-unseal |
| **Kafka** | 3-node cluster, mTLS between brokers and clients |
| **Webhook** | PagerDuty or Opsgenie staging integration |
| **Sentinel Hosts** | 2-3 target VMs or Kubernetes pods |

### Step 1: Provision Vault

```bash
# On the Vault server (or use HCP Vault)
vault server -config=/etc/vault.d/vault.hcl

# Enable KV v2 secrets engine
vault secrets enable -path=secret kv-v2

# Generate a real Ed25519 signing keypair
openssl genpkey -algorithm ed25519 -out sentinel-signer.pem
PRIV_HEX=$(openssl pkey -in sentinel-signer.pem -outform DER | tail -c 64 | xxd -p -c 128)

# Store the signing key
vault kv put secret/canary/signer private_key="$PRIV_HEX"

# Generate and store the maintenance authorization pubkey
openssl genpkey -algorithm ed25519 -out maintenance-auth.pem
PUB_HEX=$(openssl pkey -in maintenance-auth.pem -pubout -outform DER | tail -c 32 | xxd -p -c 64)
vault kv put secret/canary/control auth_pubkey="$PUB_HEX"

# Store Kafka mTLS certificates (generated by your PKI / cert-manager)
vault kv put secret/canary/kafka \
  ca_cert=@/path/to/ca.crt \
  client_cert=@/path/to/client.crt \
  client_key=@/path/to/client.key
```

### Step 2: Create a Vault Policy for Sentinel

```hcl
# sentinel-policy.hcl
path "secret/data/canary/*" {
  capabilities = ["read"]
}
path "sys/wrapping/unwrap" {
  capabilities = ["update"]
}
```

```bash
vault policy write sentinel-policy sentinel-policy.hcl
```

### Step 3: Generate Wrapped Bootstrap Tokens

```bash
# Create a single-use wrapped token for each Sentinel host
vault token create \
  -policy=sentinel-policy \
  -wrap-ttl=5m \
  -num-uses=1 \
  -metadata="host=uat-worker-01"

# Output: wrapping_token: hvs.CAESI...
# Pass this token to sentinel via --join-token flag
```

### Step 4: Configure Sentinel for UAT

```yaml
# /opt/sentinel/config/sentinel.yaml
telemetry:
  kafka_brokers:
    - kafka-uat-01:9093
    - kafka-uat-02:9093
    - kafka-uat-03:9093
  topic: canary-events
  tls: true                             # mTLS enabled
  vault_ca_cert: secret/data/canary/kafka:ca_cert
  vault_client_cert: secret/data/canary/kafka:client_cert
  vault_client_key: secret/data/canary/kafka:client_key

oob_alert:
  url: https://alerts-staging.yourcompany.com/cadoc/oob

watchdog:
  peer_socket: /run/canary/sentinel.sock
  heartbeat_interval_seconds: 10
  alert_threshold_seconds: 30

signing:
  key_source: vault
  vault_path: secret/data/canary/signer
  vault_field: private_key

maintenance:
  vault_path: secret/data/canary/control
  vault_field: auth_pubkey
```

### Step 5: Deploy Sentinel Binary

```bash
# On each target host
scp sentinel-a user@uat-worker-01:/opt/sentinel/bin/
scp sentinel.yaml user@uat-worker-01:/opt/sentinel/config/

# Start with wrapped token (single-use, expires in 5m)
ssh user@uat-worker-01
export VAULT_ADDR=https://vault-uat.yourcompany.com:8200
/opt/sentinel/bin/sentinel-a \
  --config /opt/sentinel/config/sentinel.yaml \
  --join-token "hvs.CAESI..."
```

### Step 6: Install Tetragon (Optional, for kernel-level monitoring)

```bash
# On Ubuntu/Debian VMs
curl -sL https://github.com/cilium/tetragon/releases/latest/download/tetragon-linux-amd64.tar.gz | tar xz
sudo mv tetragon /usr/local/bin/
sudo mkdir -p /etc/tetragon/tetragon.tp.d
sudo systemctl enable --now tetragon

# Sentinel will auto-detect Tetragon and use kernel-level monitoring
# Verify in logs: "[selfmon] Detected environment: Standalone Tetragon (VM)"
```

### UAT Validation Checklist

- [ ] Sentinel starts and unwraps Vault token successfully
- [ ] Signed heartbeats appear in Kafka `canary-events` topic
- [ ] `SELFMON_MODE_SELECTED` event shows correct monitoring mode
- [ ] `SENTINEL_CAPABILITY_SET` confirms privilege drop to `CAP_NET_ADMIN`
- [ ] Kill Sentinel with `kill -15` → `UNAUTHORIZED_SHUTDOWN` alert fires to OOB webhook
- [ ] Authorize shutdown with signed ticket → clean exit, no alert
- [ ] Kafka disconnect → Sentinel fails closed (exits immediately)

---

## 3. Production Environment

**Purpose:** Full zero-trust deployment with hardened Vault, mTLS Kafka, Tetragon eBPF monitoring, and automated lifecycle management.

### Key Differences from UAT

| Aspect | UAT | Production |
|--------|-----|------------|
| **Vault** | Single instance or HCP dev | HA cluster with auto-unseal (AWS KMS / GCP CKMS) |
| **Kafka TLS** | mTLS with test CA | mTLS with corporate PKI / cert-manager |
| **Tetragon** | Optional | **Mandatory** — alerts if absent |
| **Token delivery** | Manual `--join-token` | Automated via Jenkins/GitHub Actions |
| **OOB endpoint** | Staging webhook | PagerDuty P1 integration |
| **Sentinel-B** | Not deployed | Phase 2: Dual-sentinel with cross-heartbeat |
| **Key rotation** | None | Automated via Vault lease TTLs |

### Production Configuration

```yaml
# /opt/sentinel/config/sentinel.yaml
telemetry:
  kafka_brokers:
    - kafka-prod-01.internal:9093
    - kafka-prod-02.internal:9093
    - kafka-prod-03.internal:9093
  topic: canary-events-prod
  tls: true
  vault_ca_cert: secret/data/canary/kafka:ca_cert
  vault_client_cert: secret/data/canary/kafka:client_cert
  vault_client_key: secret/data/canary/kafka:client_key

oob_alert:
  url: https://events.pagerduty.com/v2/enqueue

watchdog:
  peer_socket: /run/canary/sentinel.sock
  heartbeat_interval_seconds: 10
  alert_threshold_seconds: 30

signing:
  key_source: vault
  vault_path: secret/data/canary/signer
  vault_field: private_key

maintenance:
  vault_path: secret/data/canary/control
  vault_field: auth_pubkey
```

### Production Deployment via Jenkins / GitHub Actions

```groovy
// Jenkinsfile snippet
stage('Deploy Sentinel') {
    steps {
        script {
            // 1. Generate a wrapped single-use Vault token
            def wrapToken = sh(
                script: """
                    vault token create \
                      -policy=sentinel-policy \
                      -wrap-ttl=5m \
                      -num-uses=1 \
                      -format=json | jq -r '.wrap_info.token'
                """,
                returnStdout: true
            ).trim()

            // 2. Deploy binary to target host
            sh "scp sentinel-a ${TARGET_HOST}:/opt/sentinel/bin/"
            sh "scp sentinel-prod.yaml ${TARGET_HOST}:/opt/sentinel/config/sentinel.yaml"

            // 3. Start sentinel with the wrapped token
            sh """
                ssh ${TARGET_HOST} 'VAULT_ADDR=https://vault.internal:8200 \
                  /opt/sentinel/bin/sentinel-a \
                  --config /opt/sentinel/config/sentinel.yaml \
                  --join-token ${wrapToken}'
            """
        }
    }
}
```

### Production Maintenance (Authorized Shutdown)

```bash
# 1. Sign a maintenance ticket with the authority private key
cadoc-tools sign-ticket \
  --action SHUTDOWN \
  --target prod-worker-01 \
  --key /secure/maintenance-auth.pem \
  --ttl 10m

# Output: {"action":"SHUTDOWN","target":"prod-worker-01","nonce":"...","signature":"..."}

# 2. Pass to Sentinel for authorized shutdown
ssh prod-worker-01 '/opt/sentinel/bin/sentinel-a \
  --config /opt/sentinel/config/sentinel.yaml \
  --auth-ticket-json '\''{"action":"SHUTDOWN",...}'\'' \
  --action SHUTDOWN'

# Sentinel emits MAINTENANCE_AUTHORIZED to Kafka and exits cleanly (no P1 alert)
```

---

## Self-Monitoring Modes by Environment

Sentinel automatically detects the best available monitoring strategy:

| Environment | Detection Logic | Monitoring Mode | Security Level |
|-------------|----------------|-----------------|----------------|
| **INT** (Docker) | No `kubectl`, no Tetragon | `/proc` polling (2s interval) | ⚠️ Basic |
| **UAT** (VM) | `/etc/tetragon/tetragon.tp.d/` exists + gRPC reachable | Standalone Tetragon eBPF | ✅ Strong |
| **UAT** (K8s) | `KUBERNETES_SERVICE_HOST` set + `kubectl` available | Tetragon DaemonSet + TracingPolicy | ✅ Strong |
| **Production** | Same as UAT — **alerts if degrades to /proc** | Tetragon eBPF (mandatory) | 🔒 Maximum |

> **Critical:** If a production host reports `SELFMON_MODE_SELECTED: proc-fallback`, the Detection Engine should fire a P1 alert. This could indicate an attacker uninstalled Tetragon to blind the monitoring.

---

## Vault Secrets Reference

All secrets are stored in HashiCorp Vault KV v2. Sentinel fetches them at runtime into memory only — **nothing is written to disk**.

| Vault Path | Field | Purpose | Key Type |
|------------|-------|---------|----------|
| `secret/data/canary/signer` | `private_key` | Signs all telemetry events | Ed25519 (64 bytes, hex-encoded) |
| `secret/data/canary/control` | `auth_pubkey` | Verifies maintenance tickets | Ed25519 public (32 bytes, hex) |
| `secret/data/canary/kafka` | `ca_cert` | Kafka mTLS CA certificate | PEM |
| `secret/data/canary/kafka` | `client_cert` | Kafka mTLS client certificate | PEM |
| `secret/data/canary/kafka` | `client_key` | Kafka mTLS client private key | PEM |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `wrapping token is not valid` | Token already used or expired | Generate a new wrapped token with `vault token create` |
| `Failed to initialize signer: unsupported key_source` | Missing `key_source: vault` in config | Add `key_source: vault` under `signing:` |
| `Kafka unreachable — failing closed` | Kafka not ready or wrong broker address | Check Kafka health, verify broker hostnames |
| `SELFMON_MODE_SELECTED: proc-fallback` in prod | Tetragon not installed or not running | Install Tetragon and restart Sentinel |
| `permission denied` on Vault read | Sentinel token lacks policy | Attach `sentinel-policy` to the token |

---

## 4. AWS EC2 + Real-Server Agent Enrollment (single port 443)

Backend: `docker-compose.ec2.yml`. Public host `ec2-3-89-18-5.compute-1.amazonaws.com` (`3.89.18.5`).
Only **80/443** are exposed; nginx routes by path:

| Path | Backend | Auth |
|------|---------|------|
| `/`, `/api/*` | platform-service | user JWT |
| `/install.sh`, `/downloads/*` | static (`deploy/downloads`) | public |
| `/bootstrap/get_credentials` | ingestion | one-time join token |
| `/bootstrap/renew_credentials` | ingestion | ratcheting renewal token |
| `/ingest`, `/control/killswitch`, `/bootstrap/maintenance_key` | ingestion | **mTLS client cert required** |

Ingestion's own `/bootstrap/join` is not routed; join tokens come from `POST /api/v1/dashboard/servers/token`
(or `/api/v1/bootstrap/join`) after JWT + tenant checks.

### Deploy
1. AWS: security group allows inbound 80/443 only (close 8443); attach an Elastic IP so host/IP stay stable.
2. Build artifacts locally: `bash scripts/build-release.sh` (outputs `deploy/downloads/`).
3. `scripts/transfer-to-ec2.ps1 <host>` then on the box `sudo bash deploy/ec2-setup.sh`.
   `ec2-setup.sh` creates the Canary CA, a CA-signed nginx cert with SAN for the host/IP, and sets `PUBLIC_BASE_URL`.
   Override with `PUBLIC_HOST` / `PUBLIC_IP` env vars if the address changes (delete `deploy/certs/selfsigned.*` to re-issue).

### Enroll a server
UI calls `POST /api/v1/dashboard/servers/token {server_id}`; response `install_command` looks like:
```
curl -fsSLk https://<host>/install.sh | sudo bash -s -- --token <jwt> --server https://<host> --client-id <slug>.<server-id> --ca-sha256 <hex>
```
The installer pins the CA by SHA-256, downloads and verifies the binary, writes config, starts the service, waits for
`/var/lib/canary/mtls.crt`, then deletes the one-time token. Token TTL is 15 minutes, single use.
`POST /api/v1/dashboard/servers/verify` reports `verified: true` once the first heartbeat arrives.

### Known limits
- Vault runs in dev mode (in-memory): restarting the vault container invalidates all enrolled agents.
- Browser shows a certificate warning (private CA) until a publicly trusted cert is used for the UI.
- Decoys are planted on the host in the profile's real paths (default `app-server`: `/etc/app`, `/var/backups`, `/home/deploy/.ssh`, `/opt/app/config`), rotated every `--interval` (default 600s). Use `--profile` / `--interval` on the installer to change this.
- Events flow agent -> ingestion -> Kafka `canary-events` -> platform-service `event_writer` -> `canary_decoy_files` / `tamper_alerts` (what the map, decoys and alerts pages read). The writer is at-most-once (no dead-letter queue).
