---
name: sentinel-daemon
description: "Use this skill for everything related to the hardened root-level sentinel daemon. Covers: dual-process watchdog architecture, Ed25519 event signing, Merkle-chained log integrity, systemd hardening, TPM key storage, self-tamper detection, eBPF self-protection, and seccomp profiles. This component must be deployed FIRST before any canary assets are planted."
depends_on: telemetry-bus/SKILL.md
---

# Hardened Sentinel Daemon

## Overview

The sentinel daemon is the nervous system of the entire canary detection system. It runs at root level, collects and enriches all access events, cryptographically signs and chains every event, and ships logs to the remote store before taking any local action.

It runs as **two cooperating processes** (`sentinel-a` and `sentinel-b`) that mutually heartbeat each other. If either process stops responding, the other fires an out-of-band alert directly to the remote webhook — bypassing the local logging pipeline entirely.

**This is the first component deployed. Nothing else should be started until the sentinel is confirmed healthy.**

**Language: Go** — compiled to a single static binary with no runtime dependencies on target hosts.

---

## Go Module

```
module github.com/your-org/canary/sentinel

go 1.26

require (
    github.com/cilium/ebpf         v0.13.0
    github.com/segmentio/kafka-go   v0.4.47
    golang.org/x/crypto             v0.21.0
    gopkg.in/yaml.v3                v3.0.1
)
```

---

## Process Architecture

```
┌─────────────────────────────────────────────────────────┐
│  sentinel-a (primary)          sentinel-b (watchdog)    │
│  - Collects all events         - Monitors sentinel-a    │
│  - Signs with Ed25519          - Monitors itself        │
│  - Ships to telemetry bus      - Ships to telemetry bus │
│  - Monitors sentinel-b         - Dual heartbeat         │
│                                                         │
│  ← heartbeat every 5s →                                 │
│  If gap > 15s → SENTINEL_DOWN alert (out-of-band POST)  │
└─────────────────────────────────────────────────────────┘
         ↓ signed events
   Telemetry Bus (Kafka / Vector)
         ↓
   Remote Immutable Log Store
```

Both processes write to the same Kafka topic with different `source_process` tags. The log integrity verifier expects to see events from both; a gap from either triggers an alert.

---

## File Layout

```
/opt/sentinel/
├── bin/
│   ├── sentinel-a              # Primary collector (Go static binary)
│   ├── sentinel-b              # Watchdog / redundancy (Go static binary)
│   └── sentinel-verify         # Log integrity verification tool (Go static binary)
├── config/
│   ├── sentinel.yaml           # Main configuration
│   ├── seccomp/
│   │   └── sentinel-seccomp.json  # Allowlisted syscalls
│   └── apparmor/
│       └── sentinel-apparmor   # AppArmor profile
├── keys/
│   ├── ed25519.pub             # Public key (safe to distribute)
│   └── .tpm_handle             # TPM key handle (if TPM available)
└── logs/
    └── local-chain.log         # Local Merkle-chained event log
```

---

## Configuration

```yaml
# /opt/sentinel/config/sentinel.yaml

signing:
  algorithm: ed25519
  key_source: tpm           # "tpm" (preferred) | "file" | "vault"
  tpm_handle: "0x81000001"  # Persistent key handle in TPM2
  # Fallback if TPM unavailable:
  key_file: /opt/sentinel/keys/ed25519.priv
  # Vault path (if key_source = vault):
  vault_path: "secret/canary/signing-key"

telemetry:
  kafka_brokers: ["kafka-0:9092", "kafka-1:9092"]
  topic: "canary-events"
  tls: true
  client_cert: /etc/canary/tls/client.crt
  client_key: /etc/canary/tls/client.key
  ca_cert: /etc/canary/tls/ca.crt

# Out-of-band alert path (bypasses Kafka — used when sentinel-b is down)
oob_alert:
  url: "https://hooks.pagerduty.com/..."
  method: POST
  timeout_seconds: 10
  retry_count: 3

watchdog:
  heartbeat_interval_seconds: 5
  alert_threshold_seconds: 15
  peer_socket: "/run/canary/sentinel-heartbeat.sock"

log_integrity:
  chain_algorithm: sha256
  local_log: /opt/sentinel/logs/local-chain.log
  # Local log is secondary — remote is authoritative

self_protection:
  monitor_own_pid: true
  monitor_signals: [SIGKILL, SIGSTOP, SIGTERM]
  alert_on_ptrace_attach: true
  alert_on_proc_modification: true
```

---

## Key Management

### TPM 2.0 (Preferred)

```bash
# Generate Ed25519 key in TPM (survives process restart; key never leaves TPM)
tpm2_createprimary -C e -g sha256 -G ecc -c /tmp/primary.ctx
tpm2_create -G ecc -C /tmp/primary.ctx -u /tmp/signing.pub -r /tmp/signing.priv
tpm2_load -C /tmp/primary.ctx -u /tmp/signing.pub -r /tmp/signing.priv -c /tmp/signing.ctx
tpm2_evictcontrol -C o -c /tmp/signing.ctx 0x81000001  # Persist at handle 0x81000001

# Store handle reference (not the key itself)
echo "0x81000001" > /opt/sentinel/keys/.tpm_handle
chmod 400 /opt/sentinel/keys/.tpm_handle

# Sign a test event to verify TPM key works
echo '{"test":"event"}' | tpm2_sign -c 0x81000001 -g sha256 -o /tmp/test.sig -
```

### File-Based Fallback (No TPM)

```bash
# Generate Ed25519 key pair
openssl genpkey -algorithm ed25519 -out /opt/sentinel/keys/ed25519.priv
openssl pkey -in /opt/sentinel/keys/ed25519.priv -pubout -out /opt/sentinel/keys/ed25519.pub

# Strict permissions — only root can read the private key
chmod 400 /opt/sentinel/keys/ed25519.priv
chown root:root /opt/sentinel/keys/ed25519.priv

# Distribute public key to remote log verifier
scp /opt/sentinel/keys/ed25519.pub log-verifier.internal:/etc/canary/trusted-keys/$(hostname).pub
```

---

## Event Signing and Merkle Chaining

Every event emitted by the sentinel is:
1. Serialized to a canonical JSON form (keys sorted, no trailing whitespace)
2. Appended with the SHA-256 of the previous event (Merkle chain)
3. Signed with Ed25519
4. Published to Kafka with the signature as a header

```go
package sentinel

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sync/atomic"
	"time"
)

var sequence uint64

// EmitEvent signs, chains, and prepares an event for Kafka publishing.
func EmitEvent(event map[string]interface{}, prevHash string, privKey ed25519.PrivateKey, pubKeyFingerprint string) (map[string]interface{}, string) {
	event["prev_hash"] = prevHash
	event["seq"] = atomic.AddUint64(&sequence, 1)
	event["ts"] = time.Now().UTC().Format(time.RFC3339Nano)
	hostname, _ := os.Hostname()
	event["host"] = hostname

	// Canonical JSON (sorted keys via json.Marshal on map — Go sorts map keys)
	canonical, _ := json.Marshal(event)

	hash := sha256.Sum256(canonical)
	eventHash := hex.EncodeToString(hash[:])

	sig := ed25519.Sign(privKey, canonical)

	envelope := map[string]interface{}{
		"payload":   string(canonical),
		"hash":      eventHash,
		"signature": hex.EncodeToString(sig),
		"key_id":    pubKeyFingerprint,
	}
	return envelope, eventHash
}
```

---

## Mutual Heartbeat (Unix Socket)

```go
package sentinel

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"time"
)

// StartHeartbeatServer listens on a Unix socket and responds with heartbeat ACKs.
func StartHeartbeatServer(socketPath string, selfName string) error {
	os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("heartbeat listen: %w", err)
	}
	defer listener.Close()

	for {
		conn, err := listener.Accept()
		if err != nil {
			continue
		}
		go func(c net.Conn) {
			defer c.Close()
			ack := map[string]interface{}{
				"process": selfName,
				"ts":      time.Now().UTC().Format(time.RFC3339Nano),
				"status":  "alive",
				"pid":     os.Getpid(),
			}
			json.NewEncoder(c).Encode(ack)
		}(conn)
	}
}

// CheckPeerHeartbeat dials the peer's Unix socket and verifies it responds within timeout.
func CheckPeerHeartbeat(peerSocket string, timeout time.Duration) error {
	conn, err := net.DialTimeout("unix", peerSocket, timeout)
	if err != nil {
		return fmt.Errorf("peer unreachable: %w", err)
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(timeout))
	var ack map[string]interface{}
	if err := json.NewDecoder(conn).Decode(&ack); err != nil {
		return fmt.Errorf("peer heartbeat decode: %w", err)
	}
	if ack["status"] != "alive" {
		return fmt.Errorf("peer reports non-alive status: %v", ack["status"])
	}
	return nil
}
```

---

## Kernel Layer Policy

This component does not write, compile, or load custom eBPF C programs. All kernel-level instrumentation is delegated to Tetragon (preferred) or Falco (fallback). These projects are:

- Maintained by dedicated security teams (Cilium, Falco community)
- Covered by bug bounty programs
- Subject to regular third-party security audits
- Verified against the kernel eBPF verifier on every release

**Our codebase contains zero lines of eBPF C. Our kernel attack surface is limited to the Tetragon/Falco versions we deploy.**

---

## eBPF Self-Tamper Detection

The sentinel uses a single consolidated Tetragon TracingPolicy to monitor both `kill()` and `ptrace()` targeting sentinel PIDs. All eBPF programs are Tetragon-managed — the sentinel's Go process only reads structured events from Tetragon's gRPC stream.

### Tetragon TracingPolicy: Sentinel Self-Protection

PID values are injected into the policy at runtime by the sentinel on startup using Go `text/template` rendering. The policy is re-applied every time the sentinel restarts.

```yaml
# /etc/tetragon/policies/sentinel-self-protection.yaml
# Generated at runtime — PID values injected by sentinel Go process
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: sentinel-self-protection
spec:
  kprobes:
    - call: "security_ptrace_access_check"
      syscall: false
      args:
        - index: 0
          type: "nop"
      selectors:
        - matchPIDs:
            - operator: In
              followForks: false
              values:
                - SENTINEL_A_PID   # injected at runtime via template
                - SENTINEL_B_PID
          matchActions:
            - action: Notify
```

### Policy Generation (Go text/template)

```go
func generateSentinelPolicy(sentinelAPID, sentinelBPID int) ([]byte, error) {
    tmpl := template.Must(template.ParseFiles(
        "/opt/sentinel/config/tetragon-sentinel-policy.tmpl",
    ))
    var buf bytes.Buffer
    err := tmpl.Execute(&buf, map[string]int{
        "SentinelAPID": sentinelAPID,
        "SentinelBPID": sentinelBPID,
    })
    return buf.Bytes(), err
}
```

### Go Userspace Reader

The sentinel's Go process connects to Tetragon's gRPC stream and performs all filtering, enrichment, and alerting in userspace:

```go
package selfmon

import (
	"context"
	"log"

	"github.com/cilium/tetragon/api/v1/tetragon"
	"google.golang.org/grpc"
)

// WatchTetragonStream connects to Tetragon gRPC and filters events
// targeting sentinel PIDs. All logic lives here — not in eBPF.
func WatchTetragonStream(ctx context.Context, sentinelPIDs []int32, alertFn func(event map[string]interface{})) error {
	conn, err := grpc.Dial("unix:///var/run/tetragon/tetragon.sock", grpc.WithInsecure())
	if err != nil {
		return err
	}
	defer conn.Close()

	client := tetragon.NewFineGuidanceSensorsClient(conn)
	stream, err := client.GetEvents(ctx, &tetragon.GetEventsRequest{})
	if err != nil {
		return err
	}

	pidSet := make(map[int32]bool)
	for _, pid := range sentinelPIDs {
		pidSet[pid] = true
	}

	for {
		resp, err := stream.Recv()
		if err != nil {
			return err
		}

		// USERSPACE FILTERING — eBPF only captured raw syscall args
		tp := resp.GetProcessTracepoint()
		if tp == nil {
			continue
		}

		switch tp.GetEvent() {
		case "sys_enter_kill":
			targetPID := int32(tp.GetArgs()[0].GetIntArg())
			signal := int32(tp.GetArgs()[1].GetIntArg())
			if pidSet[targetPID] {
				alertFn(map[string]interface{}{
					"type":        "SENTINEL_KILL_ATTEMPT",
					"target_pid":  targetPID,
					"signal":      signal,
					"attacker_pid": tp.GetProcess().GetPid().GetValue(),
				})
			}

		case "sys_enter_ptrace":
			targetPID := int32(tp.GetArgs()[1].GetIntArg())
			if pidSet[targetPID] {
				alertFn(map[string]interface{}{
					"type":        "SENTINEL_PTRACE_ATTEMPT",
					"target_pid":  targetPID,
					"ptrace_req":  tp.GetArgs()[0].GetIntArg(),
					"attacker_pid": tp.GetProcess().GetPid().GetValue(),
				})
			}
		}
	}
}
```

---

## eBPF Program Constraints

All eBPF programs used by the canary system (via Tetragon TracingPolicies) must adhere to these constraints:

- **Maximum program size:** 4096 instructions
- **No loops** except bounded loops with a fixed upper limit known at compile time
- **Allowed BPF helper functions only:**
  - `bpf_get_current_pid_tgid`
  - `bpf_get_current_uid_gid`
  - `bpf_probe_read_kernel`
  - `bpf_ringbuf_reserve`
  - `bpf_ringbuf_submit`
  - `bpf_ktime_get_ns`
- **Map access:** All maps must be read-only from the eBPF side, **except** the ring buffer output map
- **Kernel config:** Programs must pass the kernel verifier with `CONFIG_BPF_UNPRIV_DEFAULT_OFF=y`
- **eBPF programs must do exactly three things and nothing else:**
  1. Capture raw syscall arguments (file path, pid, uid, syscall type)
  2. Write raw bytes to a BPF ring buffer
  3. Increment a per-CPU event counter

**Explicitly prohibited in eBPF programs:**
- Path matching or string comparison
- Any filtering logic (no `if` branches based on path content)
- Rule evaluation or alerting logic
- Network calls or map writes beyond the ring buffer
- Conditional branching based on file content

---

## Userspace Reader Responsibilities

The boundary between eBPF (kernel) and Go (userspace) is strict:

| Responsibility | Where it runs | Rationale |
|---|---|---|
| Capture raw syscall args (pid, uid, path, syscall type) | **eBPF** (Tetragon) | Minimal kernel surface area |
| Write raw bytes to ring buffer | **eBPF** (Tetragon) | Only output mechanism |
| Increment per-CPU event counter | **eBPF** (Tetragon) | Metrics only |
| Filter events by sentinel PID | **Go userspace** | Logic must be auditable |
| Match file paths against canary map | **Go userspace** | Canary map changes at runtime |
| Evaluate detection rules | **Go userspace** (detection-engine) | Rules change without kernel reload |
| Deduplicate events | **Go userspace** | Stateful, needs sliding window |
| Enrich events (process lineage, K8s context) | **Go userspace** | Requires procfs + K8s API |
| Sign and chain events (Ed25519 + Merkle) | **Go userspace** | Crypto must not run in kernel |
| Emit alerts (Kafka, OOB webhook) | **Go userspace** | Network I/O |
| Apply exclusions (known-safe processes) | **Go userspace** | Exclusion list changes at runtime |

**Rule of thumb:** If the logic might change at runtime, or if it requires any state beyond the current syscall, it belongs in Go userspace — never in eBPF.

---

## eBPF Program Verification

Every eBPF program (Tetragon TracingPolicy) must be verified before activation:

1. **Pre-load verification with `llvm-objdump`:** Before loading any eBPF program, run `llvm-objdump -d` on the compiled `.o` to verify instruction count and call sites.

2. **Capture verifier log at load time:** The Tetragon log output includes the kernel verifier log for each loaded program. The sentinel must capture and store this at:
   ```
   /opt/sentinel/logs/ebpf-verifier-<policy-name>-<timestamp>.log
   ```

3. **Fail-closed on verification failure:** If Tetragon reports a verifier error for any TracingPolicy:
   - Sentinel must **refuse to start** (do not proceed with degraded eBPF monitoring)
   - Emit a `SENTINEL_EBPF_VERIFY_FAIL` event via the **out-of-band webhook** (not Kafka — Kafka may not be up yet)
   - The OOB alert includes: policy name, verifier error message, kernel version, Tetragon version
   - Sentinel then falls back to inotify-based monitoring (see Graceful Degradation below)

```go
// On Tetragon policy load failure:
func handleVerifierFailure(policyName string, verifierErr error, cfg config.OOBAlertConfig) {
    alert := map[string]interface{}{
        "type":            "SENTINEL_EBPF_VERIFY_FAIL",
        "policy":          policyName,
        "error":           verifierErr.Error(),
        "kernel":          getKernelVersion(),
        "tetragon_version": getTetragonVersion(),
        "ts":              time.Now().UTC().Format(time.RFC3339Nano),
    }
    sendOOBAlert(cfg.URL, alert) // bypasses Kafka
}
```

---

## Graceful Degradation

If Tetragon is unavailable or a verifier error occurs, the sentinel degrades gracefully — **never silently losing coverage:**

| Condition | Behavior |
|---|---|
| Tetragon not installed | Start with inotify fallback immediately |
| Tetragon installed but TracingPolicy fails verifier | Emit `SENTINEL_EBPF_VERIFY_FAIL` via OOB, fall back to inotify |
| Tetragon crashes at runtime | Emit `SENTINEL_DEGRADED`, switch to inotify within 5s |
| inotify also fails | Emit `SENTINEL_CRITICAL_DEGRADED` via OOB, poll /proc as last resort |

### Degradation event

```go
// Emitted when coverage is reduced — detection-engine uses this to adjust scoring
event := map[string]interface{}{
    "type":             "SENTINEL_DEGRADED",
    "monitoring_mode":  "inotify",     // was "tetragon"
    "coverage":         "canary_files_only", // inotify cannot monitor all syscalls
    "missing_coverage": []string{
        "ptrace_attach",
        "kill_signal",
        "proc_modification",
        "non-canary file access",
    },
    "reason": "Tetragon unavailable — verifier error on policy load",
}
```

### Key properties of degradation

- **Degradation must always be visible:** The `SENTINEL_DEGRADED` event is signed and shipped like any other event. The detection-engine uses it to know that coverage is reduced.
- **inotify fallback covers canary file reads only** — it cannot monitor kill(), ptrace(), or process-level tampering. This is a known, accepted coverage gap.
- **Alert routing treats `SENTINEL_DEGRADED` as a P2 alert** — not P1 (system is still partially functional), but urgent enough to investigate within 4 hours.
- **Never silent:** If the sentinel cannot determine its monitoring mode, it emits `SENTINEL_CRITICAL_DEGRADED` and refuses to report itself as healthy in heartbeats.

---

## Kill Switch

The kill switch allows immediate removal of all kernel-level monitoring without losing all detection capability. It is designed to be triggered within **5 minutes** of a critical eBPF or Tetragon CVE announcement.

### Trigger methods (any of these work)

a) **Ansible**: `ansible-playbook site.yml --tags kill-switch`
b) **Vault flag**: `vault kv put secret/canary/control kill_switch=true`
   *(Sentinel polls this flag every 60s and self-triggers if true)*
c) **Manual**: `systemctl stop canary-sentinel-a canary-sentinel-b`

### Kill switch behavior

- Unload all Tetragon TracingPolicies (`kubectl delete tracingpolicy`)
- Stop `sentinel-a` and `sentinel-b`
- Automatically start `inotify` fallback watcher (covers canary file reads only — reduced coverage)
- Emit `SENTINEL_KILL_SWITCH_ACTIVATED` event via out-of-band webhook
- Detection engine receives this and switches to degraded mode:
  - Tier 1 file canary rules still active (via inotify events)
  - Tier 1 PVC and DB rules still active (separate processes)
  - Tier 2 behavioral rules suspended (no syscall data)
  - `SENTINEL_DEGRADED` alert fires to notify on-call

### Ansible kill-switch task

```yaml
- name: Activate canary kill switch
  tags: kill-switch
  block:
    - name: Delete all Tetragon policies
      command: kubectl delete tracingpolicy --all -n canary-system
    - name: Stop sentinel processes
      systemd: name={{ item }} state=stopped
      loop: [canary-sentinel-a, canary-sentinel-b]
    - name: Start inotify fallback
      systemd: name=canary-inotify-watcher state=started enabled=yes
    - name: Set Vault kill switch flag
      command: vault kv put secret/canary/control kill_switch=true
```

---

## Degradation Levels

The system must never silently degrade. Every level transition must produce an alert.

### Level 0 — Full operation
Tetragon eBPF + sentinel + all canary types active
**Coverage:** syscall-level, PVC, database, behavioral

### Level 1 — eBPF suspended (kill switch activated)
inotify fallback + sentinel + PVC operator + DB listener
**Coverage:** file open events, PVC API events, database events
**Missing:** syscall metadata, process lineage, timing data
**Alert:** `SENTINEL_DEGRADED` (P2)

### Level 2 — Sentinel down (e.g. critical sentinel CVE)
inotify fallback only + PVC operator + DB listener
**Coverage:** file open events, PVC API events, database events
**Missing:** event signing, Merkle chain, behavioral scoring
**Alert:** `SENTINEL_DOWN` (P1)

### Level 3 — Full outage
No automated detection
**Coverage:** Manual monitoring only
**Alert:** `CANARY_SYSTEM_DOWN` (P1, paged to security leadership)

---

## Capability Lifecycle

Linux capabilities are dropped immediately after eBPF programs are loaded. The sentinel never holds excess capabilities during its main event loop.

### Phase 1 — Startup (capabilities needed)

| Capability | Purpose | Duration |
|---|---|---|
| `CAP_BPF` | Load Tetragon TracingPolicies / eBPF programs | Dropped after init |
| `CAP_SYS_ADMIN` | Pin eBPF maps to bpffs | Dropped after init |
| `CAP_PERFMON` | Attach perf events | Dropped after init |
| `CAP_NET_ADMIN` | Create raw sockets for Kafka TLS | **Kept at runtime** |

### Phase 2 — Runtime (drop everything except)

| Capability | Reason to keep |
|---|---|
| `CAP_NET_ADMIN` | Maintain Kafka TLS connection |
| `CAP_SYS_PTRACE` | Read `/proc` for process enrichment *(optional — drop if process lineage not needed)* |

### Phase 3 — Drop sequence

Called immediately after eBPF programs are loaded and before entering the main event loop. If it returns an error, sentinel must exit — **never run with excess capabilities.**

```go
import "kernel.org/pub/linux/libs/security/libcap/cap"

func dropCapabilitiesAfterInit() error {
    c := cap.NewSet()
    c.SetFlag(cap.Permitted, true, cap.NET_ADMIN)
    c.SetFlag(cap.Effective, true, cap.NET_ADMIN)
    // Explicitly clear SYS_ADMIN, BPF, PERFMON
    c.SetFlag(cap.Permitted, false, cap.SYS_ADMIN)
    c.SetFlag(cap.Effective, false, cap.SYS_ADMIN)
    c.SetFlag(cap.Permitted, false, cap.BPF)
    c.SetFlag(cap.Effective, false, cap.BPF)
    c.SetFlag(cap.Permitted, false, cap.PERFMON)
    c.SetFlag(cap.Effective, false, cap.PERFMON)
    if err := c.SetProc(); err != nil {
        return fmt.Errorf("capability drop failed: %w", err)
    }
    // Verify drop succeeded — never assume
    verify, err := cap.GetPID(0)
    if err != nil { return err }
    if verify.GetFlag(cap.Effective, cap.SYS_ADMIN) {
        return fmt.Errorf("CAP_SYS_ADMIN still effective after drop — aborting")
    }
    return nil
}
```

> **Note:** eBPF programs remain loaded and running after the capability drop. Dropping `CAP_BPF` does not unload already-loaded programs. The programs are pinned to bpffs and continue to run. This is intentional — we drop the ability to load **new** programs while keeping the already-loaded monitoring programs active.

### Startup call order

```
1. Load config, init signer, verify Kafka reachable
2. Apply Tetragon TracingPolicies (requires CAP_BPF, CAP_SYS_ADMIN, CAP_PERFMON)
3. Call dropCapabilitiesAfterInit()         ← caps dropped HERE
4. Emit SENTINEL_CAPABILITY_SET event       ← proof of drop
5. Start heartbeat, self-monitor, main event loop
```

---

## Capability Verification

On startup, after the capability drop, the sentinel must emit this event to Kafka before any canary monitoring begins:

```json
{
  "type": "SENTINEL_CAPABILITY_SET",
  "effective": ["CAP_NET_ADMIN"],
  "permitted": ["CAP_NET_ADMIN"],
  "inheritable": []
}
```

This event is signed and chained like all other events. The detection-engine must verify:

- This event appears **within 30 seconds** of sentinel startup
- The `effective` and `permitted` sets contain **only** `CAP_NET_ADMIN` (and optionally `CAP_SYS_PTRACE` if process lineage is enabled)
- The `inheritable` set is **empty**
- If the event is missing or the capability sets are larger than expected, emit a `SENTINEL_CAP_MISSING` alert (P1 severity)

---

## systemd Hardening

```ini
# /etc/systemd/system/canary-sentinel-a.service

[Unit]
Description=Canary Sentinel A (Primary Collector)
After=network-online.target
Requires=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=notify
ExecStart=/opt/sentinel/bin/sentinel-a --config /opt/sentinel/config/sentinel.yaml
Restart=always
RestartSec=2

# Run as root (required for eBPF and process monitoring)
User=root
Group=root

# Filesystem hardening
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/sentinel/logs /run/canary
PrivateTmp=true
PrivateDevices=false   # Needs /dev/tpm0

# Capability restrictions — Phase 1 set only (code drops to Phase 2 after init)
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SYS_PTRACE CAP_NET_ADMIN CAP_BPF CAP_PERFMON
# No AmbientCapabilities — capabilities are dropped in code after eBPF load,
# not held permanently via systemd
SecureBits=no-setuid-fixup-locked  # Prevent capability re-acquisition after drop

# Process isolation
NoNewPrivileges=true
LockPersonality=true
MemoryDenyWriteExecute=false  # eBPF JIT requires executable memory
RestrictRealtime=true
RestrictNamespaces=true

# Seccomp allowlist
SeccompFilter=/opt/sentinel/config/seccomp/sentinel-seccomp.json

# Resource limits
CPUQuota=10%              # Prevent resource starvation
MemoryMax=256M
TasksMax=50

# Watchdog integration (systemd will restart if WatchdogPing is not called)
WatchdogSec=30
NotifyAccess=main

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/canary-sentinel-b.service
# Mirror of sentinel-a with different binary path
# The two services reference each other's PID files for mutual monitoring
ExecStart=/opt/sentinel/bin/sentinel-b --config /opt/sentinel/config/sentinel.yaml --peer-pid-file /run/canary/sentinel-a.pid
```

---

## Seccomp Profile

Allow only the syscalls the sentinel genuinely needs. This makes it very hard for an attacker who has compromised the sentinel process to do anything useful with it:

```json
{
  "defaultAction": "SCMP_ACT_KILL_PROCESS",
  "syscalls": [
    {
      "names": [
        "read", "write", "open", "openat", "close", "stat", "fstat",
        "mmap", "mprotect", "munmap", "brk", "rt_sigaction", "rt_sigprocmask",
        "ioctl", "pread64", "pwrite64", "readv", "writev", "access", "pipe",
        "select", "sched_yield", "mremap", "msync", "mincore", "madvise",
        "shmget", "shmat", "shmctl", "dup", "dup2", "pause", "nanosleep",
        "getitimer", "setitimer", "getpid", "sendfile", "socket", "connect",
        "accept", "sendto", "recvfrom", "sendmsg", "recvmsg", "shutdown",
        "bind", "listen", "getsockname", "getpeername", "socketpair",
        "setsockopt", "getsockopt", "clone", "fork", "vfork", "execve",
        "exit", "wait4", "kill", "uname", "fcntl", "fsync", "fdatasync",
        "getdents", "getcwd", "chdir", "fchdir", "rename", "mkdir", "rmdir",
        "creat", "link", "unlink", "symlink", "readlink", "chmod", "fchmod",
        "chown", "fchown", "lchown", "getuid", "getgid", "geteuid", "getegid",
        "getgroups", "getppid", "getpgrp", "setsid", "setuid", "setgid",
        "gettimeofday", "getrlimit", "getrusage", "sysinfo", "times",
        "ptrace",  "syslog", "getpriority", "setpriority",
        "mlock", "munlock", "mlockall", "munlockall",
        "prctl", "arch_prctl", "setrlimit", "sync", "gettid",
        "tgkill", "set_tid_address", "clock_gettime", "clock_getres",
        "clock_nanosleep", "exit_group", "epoll_wait", "epoll_ctl", "epoll_create",
        "epoll_create1", "tee", "splice", "inotify_init", "inotify_add_watch",
        "inotify_rm_watch", "openat2", "bpf", "perf_event_open",
        "getrandom", "memfd_create", "copy_file_range",
        "io_uring_setup", "io_uring_enter", "io_uring_register",
        "futex", "sched_getaffinity", "sched_setaffinity",
        "clock_gettime", "sigaltstack"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

---

## Startup and Verification

```bash
# Deploy sentinel (must be first)
systemctl daemon-reload
systemctl enable --now canary-sentinel-a canary-sentinel-b

# Verify both processes running and heartbeating
systemctl status canary-sentinel-a canary-sentinel-b
journalctl -u canary-sentinel-a --since "1 minute ago" | grep "HEARTBEAT_OK"

# Verify signing key is accessible
/opt/sentinel/bin/sentinel-a --test-sign
# Expected output: Signed test event: [base64 signature] ✓

# Verify events are reaching Kafka
kafkacat -b kafka-0:9092 -t canary-events -C -o -1 -c 5

# Verify Merkle chain integrity for last 100 events
/opt/sentinel/bin/sentinel-verify --check-chain --last 100

# Test self-tamper detection: send SIGTERM to sentinel-a (should alert, then restart)
kill -TERM $(cat /run/canary/sentinel-a.pid)
sleep 5
grep "SENTINEL_KILL_ATTEMPT" /var/log/canary/sentinel.log
```

---

## Dependencies

- `tpm2-tools` >= 4.0 (for TPM key storage)
- Go 1.26+ (build only — no runtime dependency on target hosts)
- `kernel.org/pub/linux/libs/security/libcap/cap` (capability management)
- `golang.org/x/crypto` (Ed25519 signing — stdlib `crypto/ed25519` also works)
- `github.com/segmentio/kafka-go` (Kafka producer)
- `tetragon` >= 0.11 (eBPF kernel instrumentation — no custom eBPF C)
- Linux kernel >= 5.8 (eBPF CO-RE support)
- `systemd` >= 245 (for `WatchdogSec` and `SeccompFilter` file support)
- Kafka accessible before sentinel starts
- Remote log endpoint accessible before sentinel starts

---

## Vendor Security Tracking

Since all kernel-level instrumentation is delegated to Tetragon/Falco, tracking their security posture is critical:

- **Subscribe to Tetragon CVE notifications:** https://github.com/cilium/tetragon/security/advisories
- **Subscribe to Falco CVE notifications:** https://github.com/falcosecurity/falco/security/advisories
- **Patch policy:** Patch Tetragon/Falco within **48 hours** of a critical CVE
- **Zero-day response:** If a critical CVE is announced and a patch is not yet available, fall back to inotify immediately (see Graceful Degradation section) until patched. The sentinel emits `SENTINEL_DEGRADED` with `reason: "CVE mitigation — Tetragon disabled pending patch"` so the detection-engine knows coverage is reduced.

---

## Dependency Pinning

`go.sum` must be committed and verified. Use `-goflags="-mod=readonly"` in CI to prevent accidental dependency updates during build.

### Automated Dependency Management

Dependabot or Renovate must be configured to open PRs for dependency updates — **never update dependencies manually.**

### Security-Critical Dependencies

The following dependencies are security-critical and must be **reviewed by a second engineer** before merging any update:

| Dependency | Reason |
|---|---|
| `golang.org/x/crypto` | Ed25519 signing — core integrity mechanism |
| `github.com/segmentio/kafka-go` | Event transport — compromise = event loss |
| `kernel.org/pub/linux/libs/security/libcap/cap` | Capability management — compromise = privilege escalation |
| `github.com/cilium/tetragon` (API client) | Tetragon gRPC — compromise = monitoring bypass |

These must be pinned to **exact versions** in `go.mod`, not ranges. Every update PR must include:
- Changelog review of the updated dependency
- `go mod tidy && go mod verify` passes
- All tests pass with the new version

---

## Runtime Binary Verification

On startup, `sentinel-a` verifies its own binary hash against a value stored in Vault (not locally — local storage can be tampered):

```go
func verifySelfIntegrity() error {
    exe, err := os.Executable()
    if err != nil { return err }

    f, err := os.Open(exe)
    if err != nil { return err }
    defer f.Close()

    h := sha256.New()
    if _, err := io.Copy(h, f); err != nil { return err }
    actual := hex.EncodeToString(h.Sum(nil))

    // Expected hash fetched from Vault at startup
    // (not stored locally — local storage can be tampered)
    expected, err := vault.GetSecret("canary/binary-hashes/sentinel-a")
    if err != nil { return err }

    if actual != expected {
        return fmt.Errorf("BINARY_INTEGRITY_FAIL: expected %s got %s",
            expected, actual)
    }
    return nil
}
```

### Failure Behavior

If `verifySelfIntegrity()` fails, sentinel must:

1. **POST** to out-of-band webhook: `BINARY_TAMPERED` event (bypasses Kafka)
2. **Exit immediately** — do not start monitoring

```go
if err := verifySelfIntegrity(); err != nil {
    sendOOBAlert(cfg.OOBAlert.URL, map[string]interface{}{
        "type":   "BINARY_TAMPERED",
        "binary": "sentinel-a",
        "error":  err.Error(),
        "host":   hostname,
    })
    os.Exit(1) // never run with a tampered binary
}
```

**Rationale:** A tampered binary that starts monitoring is worse than no monitoring at all — it may silently drop events or inject false negatives.

---

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `bpf: Operation not permitted` | Missing `CAP_BPF` or lockdown | Verify systemd service has `CAP_BPF`; check lockdown mode |
| TPM key not found at handle | Key not persisted | Re-run `tpm2_evictcontrol` to persist at handle |
| Heartbeat gap alert storms | Clock skew between sentinel-a and sentinel-b | NTP must be synced; `chronyc tracking` |
| Kafka publish fails on start | Kafka not ready yet | Add `After=kafka.service` if co-located; add retry logic |
| Seccomp kills sentinel | Syscall not in allowlist | Check `dmesg | grep SECCOMP` for blocked syscall; add to profile |
| `BINARY_INTEGRITY_FAIL` on startup | Binary hash doesn't match Vault | Re-deploy from artifact registry; investigate host for tampering |

