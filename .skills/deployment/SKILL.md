---
name: deployment
description: "Use this skill for deploying the full canary system from scratch or updating individual components. Covers: bootstrapping order, Ansible role structure, Helm chart deployment, environment variable management via Vault, post-deploy validation, upgrade procedures, and rollback steps."
depends_on: []
---

# Deployment

## Overview

The canary system must be deployed in a specific order. Deploying canary assets before the sentinel is running creates a detection gap. This skill covers the complete deployment sequence for both fresh installs and updates.

**Mandatory deployment order:**
1. Telemetry bus (Kafka + Vector + remote store)
2. Sentinel daemon (both processes)
3. File canary engine
4. PVC watchdog (Kubernetes environments)
5. Database canary mesh
6. Detection engine
7. Alert & response pipeline
8. End-to-end validation

---

## Prerequisites Checklist

Run before any deployment step:

```bash
#!/bin/bash
# /opt/canary/deploy/preflight.sh

PASS=0; FAIL=0

check() {
  local desc=$1; shift
  if "$@" &>/dev/null; then
    echo "✓ $desc"; ((PASS++))
  else
    echo "✗ $desc — FAILED"; ((FAIL++))
  fi
}

# Kernel
check "Kernel >= 5.8"          bash -c "[ $(uname -r | cut -d. -f1-2 | tr -d .) -ge 58 ]"
check "eBPF available"         test -f /sys/fs/bpf/type

# Tools
check "tetragon installed"     which tetragon
check "falco installed"        which falco
check "jq installed"           which jq
check "tpm2-tools installed"   which tpm2_getcap
check "kafkacat installed"     which kafkacat

# Connectivity
check "Kafka reachable"        kafkacat -b "$CANARY_KAFKA_BROKERS" -L -t canary-events
check "Remote log reachable"   curl -sf "$CANARY_REMOTE_LOG_ENDPOINT/health"
check "Vault reachable"        vault status

# Kubernetes (skip if not K8s environment)
if command -v kubectl &>/dev/null; then
  check "K8s version >= 1.26"  bash -c "kubectl version --short 2>/dev/null | grep -q '1\.[2-9][6-9]'"
  check "VolumeSnapshot CRD"   kubectl get crd volumesnapshots.snapshot.storage.k8s.io
fi

echo ""; echo "Preflight: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
```

---

## Ansible Role Structure

```
ansible/
├── site.yml                    # Master playbook — runs all roles in order
├── inventory/
│   ├── production.ini
│   └── group_vars/
│       ├── all.yaml            # Shared vars (Vault addresses, etc.)
│       ├── app_servers.yaml
│       ├── db_servers.yaml
│       └── k8s_nodes.yaml
└── roles/
    ├── canary-common/          # Shared: TLS certs, directories, users
    ├── canary-telemetry/       # Kafka topic creation, Vector agent
    ├── canary-sentinel/        # Go binary install + systemd
    ├── canary-files/           # Go binary deployer + eBPF policies
    ├── canary-db/              # PostgreSQL/MySQL canary mesh (Python)
    └── canary-detection/       # Detection engine (Python)
```

### Master Playbook

```yaml
# ansible/site.yml
---
- name: Canary system — full deployment
  hosts: all
  become: true

  pre_tasks:
    - name: Run preflight checks
      script: /opt/canary/deploy/preflight.sh
      changed_when: false

  roles:
    - role: canary-common
      tags: [common, always]

    - role: canary-telemetry
      tags: [telemetry]
      # Wait for Kafka to be healthy before proceeding
      post_tasks:
        - name: Wait for Kafka topic
          command: kafkacat -b "{{ canary_kafka_brokers }}" -L -t canary-events
          retries: 10
          delay: 10

    - role: canary-sentinel
      tags: [sentinel]
      post_tasks:
        - name: Wait for sentinel heartbeat
          wait_for:
            path: /run/canary/sentinel-a.pid
            timeout: 30

    - role: canary-files
      tags: [files]

    - role: canary-db
      tags: [db]
      when: "'db_servers' in group_names"

    - role: canary-detection
      tags: [detection]
```

### canary-common Role

```yaml
# ansible/roles/canary-common/tasks/main.yml
---
- name: Create canary user (no login shell)
  user:
    name: canary
    shell: /sbin/nologin
    system: true

- name: Create directory structure
  file:
    path: "{{ item }}"
    state: directory
    owner: root
    group: root
    mode: "0750"
  loop:
    - /opt/canary/bin
    - /opt/canary/config
    - /opt/canary/logs

## Secure Boot: Vault Response Wrapping (Approach 3)

To avoid storing persistent Vault tokens on disk, use the **Response Wrapping** flow during deployment:

### 1. Generate Wrapped Token (on Deployment Server)
The Ansible/CI controller fetches a wrapped AppRole token from Vault:
```bash
# Request a token wrapped for 60 seconds
WRAPPED_TOKEN=$(vault write -wrap-ttl=60s -field=wrapping_token auth/approle/login role_id=$ROLE_ID)
```

### 2. Inject into Sentinel (as Environment Variable)
Ansible starts the Sentinel service, passing the wrapped token via `Environment=` or a temporary systemd override:
```ini
# /etc/systemd/system/canary-sentinel-a.service.d/override.conf
[Service]
Environment="VAULT_WRAPPED_TOKEN={{ WRAPPED_TOKEN }}"
```

### 3. Automatic Unwrapping
The Sentinel binary detects the environment variable, uses its internal Vault API client to exchange it, and stores the real token **only in its process memory**. It then unsets the environment variable so it cannot be inspected. No external `vault` binary is required on the host.
    - /opt/canary/keys
    - /run/canary
    - /opt/sentinel/bin
    - /opt/sentinel/config
    - /opt/sentinel/keys

- name: Distribute CA certificate
  copy:
    src: files/ca.crt
    dest: /etc/canary/tls/ca.crt
    mode: "0644"

- name: Fetch component TLS cert from Vault
  community.hashi_vault.vault_read:
    path: "pki/issue/canary-{{ inventory_hostname }}"
  register: tls_cert

- name: Write component TLS cert
  copy:
    content: "{{ tls_cert.data.certificate }}"
    dest: /etc/canary/tls/component.crt
    mode: "0644"

- name: Write component TLS key
  copy:
    content: "{{ tls_cert.data.private_key }}"
    dest: /etc/canary/tls/component.key
    mode: "0400"
    owner: root

- name: Enable kernel lockdown (requires reboot)
  lineinfile:
    path: /etc/default/grub
    regexp: '^GRUB_CMDLINE_LINUX='
    line: 'GRUB_CMDLINE_LINUX="lockdown=integrity lsm=lockdown,yama,apparmor"'
  register: grub_changed
  notify: Update grub
```

### canary-sentinel Role (Go Binary Deployment)

```yaml
# ansible/roles/canary-sentinel/tasks/main.yml
---
- name: Download sentinel Go binaries from artifact registry
  get_url:
    url: "{{ canary_artifact_base_url }}/sentinel/{{ canary_version }}/{{ item }}-linux-amd64"
    dest: "/opt/sentinel/bin/{{ item }}"
    mode: "0755"
    owner: root
    group: root
    checksum: "sha256:{{ lookup('url', canary_artifact_base_url + '/sentinel/' + canary_version + '/' + item + '-linux-amd64.sha256') }}"
  loop:
    - sentinel-a
    - sentinel-b
    - sentinel-verify

- name: Deploy sentinel configuration
  template:
    src: sentinel.yaml.j2
    dest: /opt/sentinel/config/sentinel.yaml
    mode: "0600"
    owner: root
  notify: Restart sentinel

- name: Deploy seccomp profile
  copy:
    src: sentinel-seccomp.json
    dest: /opt/sentinel/config/seccomp/sentinel-seccomp.json
    mode: "0644"

- name: Deploy systemd unit files
  template:
    src: "{{ item }}.j2"
    dest: "/etc/systemd/system/{{ item }}"
    mode: "0644"
  loop:
    - canary-sentinel-a.service
    - canary-sentinel-b.service
  notify:
    - Reload systemd
    - Restart sentinel

- name: Enable and start sentinel services
  systemd:
    name: "{{ item }}"
    enabled: true
    state: started
  loop:
    - canary-sentinel-a
    - canary-sentinel-b
```

### canary-files Role (Go Binary Deployment)

```yaml
# ansible/roles/canary-files/tasks/main.yml
---
- name: Download canary-deployer Go binary
  get_url:
    url: "{{ canary_artifact_base_url }}/deployer/{{ canary_version }}/canary-deployer-linux-amd64"
    dest: /opt/canary/bin/canary-deployer
    mode: "0755"
    owner: root
    checksum: "sha256:{{ lookup('url', canary_artifact_base_url + '/deployer/' + canary_version + '/canary-deployer-linux-amd64.sha256') }}"

- name: Download canary-rotator Go binary
  get_url:
    url: "{{ canary_artifact_base_url }}/deployer/{{ canary_version }}/canary-rotator-linux-amd64"
    dest: /opt/canary/bin/canary-rotator
    mode: "0755"
    owner: root

- name: Deploy canary profiles
  copy:
    src: "profiles/{{ canary_profile }}.yaml"
    dest: /opt/canary/config/profiles/
    mode: "0644"

- name: Deploy canary templates
  copy:
    src: templates/
    dest: /opt/canary/templates/
    mode: "0644"

- name: Run canary deployer
  command: /opt/canary/bin/canary-deployer --profile {{ canary_profile }}
  register: deployer_result
  changed_when: deployer_result.rc == 0
```

---

## Build Artifacts

Go binaries are compiled in CI and distributed as release artifacts. Ansible fetches pre-compiled binaries from the internal artifact registry (Nexus, Artifactory, or S3 release bucket) rather than building on the target host.

```bash
# CI build script (runs in CI pipeline, not on target hosts)
for module in sentinel deployer chain-verifier pvc-operator; do
  cd src/$module
  GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" \
    -o dist/${module}-linux-amd64 ./cmd/
  sha256sum dist/${module}-linux-amd64 > dist/${module}-linux-amd64.sha256
  # Upload to artifact registry
  curl -T dist/${module}-linux-amd64 \
    "${ARTIFACT_REGISTRY}/canary/${module}/${VERSION}/${module}-linux-amd64"
done
```

**Deployment split:**
- **Go hosts** (sentinel, K8s nodes): no Python runtime needed — just the static binary
- **Central services host**: Python 3.11+, Docker or venv for detection-engine, alert-response, db-canary

---

## Helm Chart Deployment (Kubernetes)

```bash
# Add canary Helm repo
helm repo add canary-system https://charts.canary.internal
helm repo update

# Install in the canary-system namespace (create if not exists)
kubectl create namespace canary-system --dry-run=client -o yaml | kubectl apply -f -

# Install PVC watchdog operator (Go binary)
helm install canary-pvc-watchdog canary-system/pvc-watchdog \
  --namespace canary-system \
  --values helm/values-production.yaml \
  --set image.tag="$(cat /opt/canary/VERSION)" \
  --set kafka.brokers="$CANARY_KAFKA_BROKERS" \
  --set tls.caSecretName="canary-ca-cert" \
  --wait --timeout 5m

# Install K8s-side sentinel DaemonSet (Go binary)
helm install canary-sentinel canary-system/sentinel \
  --namespace canary-system \
  --values helm/values-production.yaml \
  --wait --timeout 5m
```

```yaml
# helm/values-production.yaml
image:
  repository: registry.internal/canary-system
  pullPolicy: Always

sentinel:
  resources:
    requests: { cpu: "100m", memory: "128Mi" }
    limits:   { cpu: "500m", memory: "256Mi" }

kafka:
  tls: true
  sasl:
    mechanism: SCRAM-SHA-512

pvcWatchdog:
  storageClass: "standard"
  namespaces: ["production", "staging", "database"]
  snapshotAllowlist:
    - serviceAccount: "velero"
      namespace: "velero"
    - serviceAccount: "db-backup-operator"
      namespace: "database"
```

---

## Secrets Management (Vault)

Never put credentials in Ansible vars or Helm values files. Fetch at deploy time:

```bash
# Bootstrap Vault secrets for canary system
vault kv put secret/canary/signing \
  ed25519_privkey="$(base64 -w0 /tmp/ed25519.priv)"

vault kv put secret/canary/kafka \
  username="sentinel" \
  password="$(openssl rand -base64 32)"

vault kv put secret/canary/alerts \
  pagerduty_key="$PAGERDUTY_ROUTING_KEY" \
  slack_webhook="$SLACK_WEBHOOK_URL"

vault kv put secret/canary/db \
  postgres_conn="postgres://canary_monitor:$(openssl rand -base64 24)@db-prod.internal/prod"

# Maintenance key (the PRIVATE key for signing auth tickets)
# This should only be accessible to the CI/CD pipeline or security team
vault kv put secret/canary/maintenance \
  ed25519_privkey="$(base64 -w0 /path/to/secure/maintenance.key)"

# Sentinel fetches these at startup via Vault agent sidecar
# or direct API call with a short-lived token
```

---

## Post-Deploy Validation

Run after every deployment (fresh or update):

```bash
#!/bin/bash
# /opt/canary/deploy/validate.sh

echo "=== Canary System Post-Deploy Validation ==="
FAIL=0

# 1. Sentinel processes running
systemctl is-active canary-sentinel-a canary-sentinel-b || { echo "✗ Sentinel not running"; ((FAIL++)); }
echo "✓ Sentinel processes active"

# 2. Heartbeat events flowing to Kafka
LAST_HB=$(kafkacat -b "$CANARY_KAFKA_BROKERS" -t canary-heartbeats -C -o -1 -c 1 2>/dev/null \
  | jq -r '.ts // empty')
[ -n "$LAST_HB" ] && echo "✓ Heartbeat in Kafka: $LAST_HB" \
  || { echo "✗ No heartbeat in Kafka"; ((FAIL++)); }

# 3. Canary files exist and are watched
CANARY_COUNT=$(jq '.canaries | length' /opt/canary/config/canary-map.json)
[ "$CANARY_COUNT" -gt 0 ] && echo "✓ $CANARY_COUNT canary files registered" \
  || { echo "✗ No canary files registered"; ((FAIL++)); }

# 4. Trigger a canary file access and verify alert fires
TRIGGER_PATH=$(jq -r '.canaries[0].path' /opt/canary/config/canary-map.json)
cat "$TRIGGER_PATH" > /dev/null 2>&1
sleep 5
ALERT=$(kafkacat -b "$CANARY_KAFKA_BROKERS" -t canary-events -C -o -10 -c 10 2>/dev/null \
  | jq 'select(.type == "CANARY_FILE_EVENT") | .file' | grep -c "$TRIGGER_PATH")
[ "$ALERT" -gt 0 ] && echo "✓ File canary access detected" \
  || { echo "✗ File canary access NOT detected"; ((FAIL++)); }

# 5. Verify Merkle chain is unbroken (last 100 events)
/opt/sentinel/bin/sentinel-verify --check-chain --last 100 \
  && echo "✓ Merkle chain intact" \
  || { echo "✗ Merkle chain broken"; ((FAIL++)); }

# 6. Verify remote log is receiving events
REMOTE_COUNT=$(curl -sf "$CANARY_REMOTE_LOG_ENDPOINT/api/count?last=5m" | jq '.count')
[ "${REMOTE_COUNT:-0}" -gt 0 ] && echo "✓ Remote log receiving events ($REMOTE_COUNT in last 5m)" \
  || { echo "✗ Remote log not receiving events"; ((FAIL++)); }

echo ""; echo "Validation: $((6-FAIL)) passed, $FAIL failed"
[ $FAIL -eq 0 ] && echo "DEPLOYMENT HEALTHY" && exit 0
echo "DEPLOYMENT HAS ISSUES — investigate before proceeding" && exit 1
```

---

## Upgrade Procedure

```bash
# 1. Always upgrade in reverse order of dependency
# (upgrade detection-engine before sentinel, sentinel before telemetry)

# 2. Drain detection engine consumers before upgrading
kafka-consumer-groups.sh --bootstrap-server kafka-0:9092 \
  --group detection --describe

# 3. Generate a signed REDEPLOY ticket (run on secure workstation)
generate-ticket \
  --key /path/to/maintenance.key \
  --action REDEPLOY \
  --target app-server-1 \
  --binary sentinel-a \
  --new-hash $(sha256sum dist/sentinel-a-linux-amd64 | awk '{print $1}') \
  --issuer "ci-pipeline" \
  --ttl 10m \
  --output /tmp/redeploy-ticket.json

# 4. Upgrade component (example: sentinel with signed ticket)
TICKET_JSON=$(cat /tmp/redeploy-ticket.json)
ansible-playbook site.yml --tags sentinel --limit production \
  -e "canary_version=1.2.0" \
  -e "auth_ticket_json=${TICKET_JSON}"

# 5. Validate before upgrading next component
/opt/canary/deploy/validate.sh

# 6. Never upgrade sentinel and telemetry simultaneously
# (risk of dropping events during the transition window)
```

---

## Rollback

```bash
# Rollback a single component to the previous version
ansible-playbook site.yml --tags sentinel --limit production \
  -e "canary_version=1.1.0" -e "canary_rollback=true"

# For Helm components:
helm rollback canary-pvc-watchdog --namespace canary-system

# After rollback, always re-run validation
/opt/canary/deploy/validate.sh
```

---

## Binary Integrity

Go binaries (`sentinel-a`, `sentinel-b`, `canary-deployer`, `chain-verifier`, `pvc-operator`) are distributed as release artifacts. Every binary must pass through a strict integrity pipeline.

### a) Reproducible CI Build

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath \
  -ldflags="-s -w -buildid=" \
  -o sentinel-a ./cmd/sentinel-a
```

| Flag | Purpose |
|---|---|
| `-trimpath` | Removes local filesystem paths from the binary |
| `-buildid=` | Makes the build reproducible (same input = same hash) |
| `CGO_ENABLED=0` | Produces a fully static binary with no libc dependency |
| `-s -w` | Strips debug symbols and DWARF tables |

### b) Cosign Signing

Every binary is signed with [cosign](https://github.com/sigstore/cosign) after build. The cosign public key is distributed separately from the binary and stored in the Ansible inventory.

```bash
# Sign after build
cosign sign-blob \
  --key cosign.key \
  --output-signature sentinel-a.sig \
  sentinel-a

# Verify (used by Ansible on target hosts)
cosign verify-blob \
  --key /etc/canary/keys/cosign.pub \
  --signature sentinel-a.sig \
  sentinel-a
```

### c) Ansible Verification Before Installation

```yaml
- name: Verify sentinel binary signature
  command: >
    cosign verify-blob
    --key {{ cosign_pubkey_path }}
    --signature {{ binary_path }}.sig
    {{ binary_path }}
  register: result
  failed_when: result.rc != 0

- name: Record binary hash in immutable log
  shell: >
    sha256sum {{ binary_path }} | awk '{print $1}'
  register: binary_hash

- name: Emit BINARY_INSTALLED event to Kafka
  command: >
    /opt/sentinel/bin/sentinel-a --emit-event
    '{"type":"BINARY_INSTALLED","binary":"{{ binary_name }}","sha256":"{{ binary_hash.stdout }}","host":"{{ inventory_hostname }}"}'
```

### d) Post-Installation Integrity Monitoring

After installation, the binary hash is permanently stored in the immutable log as a `BINARY_INSTALLED` event. The independent verifier agent (see telemetry-bus/SKILL.md) periodically checks binary hashes on disk. Any change emits `BINARY_TAMPERED` (P1 alert).

---

## SBOM Generation

Every Go binary release must include a Software Bill of Materials (SBOM).

### Generation

```bash
# Install syft
go install github.com/anchore/syft/cmd/syft@latest

# Generate SBOM for sentinel module
cd src/sentinel
syft packages . -o spdx-json > sentinel-sbom.spdx.json
```

### Storage and Scanning

- SBOM is stored alongside the binary in the artifact registry
- Scanned with `grype` on every release:

```bash
grype sbom:sentinel-sbom.spdx.json --fail-on critical
```

### Vulnerability Policy

| Severity | Action |
|---|---|
| **Critical** | Blocks the release — must be fixed before merging |
| **High** | Must be remediated within **7 days** |
| Tetragon / Falco | eBPF runtime monitoring (must be running) |
| Kafka / Redpanda | Central telemetry bus |
| HashiCorp Vault | Central secret storage (Sentinel uses internal API client) |
| jq / kafkacat | Debugging only (optional) |
| **Low** | Advisory only |

---

## Common Deployment Errors

| Error | Cause | Fix |
|-------|-------|-----|
| Sentinel fails to start: `vault: permission denied` | Vault token expired | Re-run `vault login` with deployment service account |
| eBPF policy not loading | Kernel lockdown not yet active | Reboot host after GRUB update; verify with `cat /sys/kernel/security/lockdown` |
| Kafka topic creation fails: `topic exists` | Previous partial deploy | Verify topic config matches; skip creation if already correct |
| Canary PVC in Pending | StorageClass not found | `kubectl get storageclass`; update `values.yaml` |
| Validation step 4 fails (file canary not detected) | eBPF probe not loaded for new canary path | Re-apply Tetragon policy after canary-deployer runs |
| Cosign verify fails | Public key mismatch or binary tampered | Re-download from artifact registry; verify cosign key matches inventory |

