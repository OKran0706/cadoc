---
name: file-canary-engine
description: "Use this skill for everything related to generating, placing, and monitoring decoy files on Linux servers. Covers: context-aware canary file generation, inotify and eBPF-based access monitoring, bulk-read detection, metadata-change alerting, and canary lifecycle management (rotation, cleanup)."
depends_on: sentinel-daemon/SKILL.md
---

# File Canary Engine

## Overview

The file canary engine plants high-fidelity decoy files across Linux servers and monitors them for any access. Because no legitimate process should ever touch these files, any access event is an unambiguous, high-confidence intrusion signal.

Detection is handled by eBPF probes (preferred) via Tetragon or Falco, with inotify as a fallback for environments where eBPF is unavailable.

**Language: Go** — canary-deployer and canary-rotator are compiled to single static binaries. The inotify fallback watcher is Bash.

---

## Go Module

```
module github.com/your-org/canary/deployer

go 1.26

require (
    gopkg.in/yaml.v3 v3.0.1
)
```

The deployer and rotator use Go's `text/template` (stdlib), `encoding/json` (stdlib), `crypto/rand` (stdlib), and `gopkg.in/yaml.v3` for profile parsing. No additional dependencies required.

---

## Directory Layout

```
/opt/canary/
├── bin/
│   ├── canary-deployer          # Generates and places canary files (Go static binary)
│   ├── canary-rotator           # Rotates canary files on schedule (Go static binary)
│   └── canary-cleaner           # Removes stale canaries safely (Go static binary)
├── config/
│   ├── profiles/                # Per-server profile definitions (YAML)
│   │   ├── app-server.yaml
│   │   ├── db-server.yaml
│   │   └── k8s-node.yaml
│   ├── exclusions.yaml          # Known-good processes exempt from alerting
│   └── canary-map.json          # Registry of all planted canaries + hashes
├── templates/                   # File content templates per category (Go text/template)
│   ├── credentials/
│   ├── configs/
│   ├── dumps/
│   └── keys/
└── logs/
    └── access.log               # Local access log (also shipped remotely)
```

---

## Canary File Generation

### Profile-Based Generation

The deployer reads a server profile (auto-detected from hostname or explicitly passed) and generates files that fit the environment:

```yaml
# config/profiles/app-server.yaml
profile: app-server
target_directories:
  - path: /home/deploy/.ssh
    canary_type: ssh_key
    count: 1
    blend_with: real   # copies timestamp/permissions from neighbor files
  - path: /etc/app
    canary_type: config_backup
    count: 2
  - path: /var/backups
    canary_type: db_dump
    count: 1
  - path: /opt/app/config
    canary_type: env_file
    count: 1

naming_strategy: contextual   # uses names matching real files in that directory
timestamp_strategy: blend     # atime/mtime match neighboring real files
permission_strategy: inherit  # chmod/chown copied from nearest real file
```

```yaml
# config/profiles/k8s-node.yaml
profile: k8s-node
target_directories:
  - path: /etc/kubernetes
    canary_type: kubeconfig_backup
    count: 1
  - path: /var/lib/kubelet
    canary_type: serviceaccount_token
    count: 1
  - path: /root
    canary_type: credentials
    count: 1
```

### Running the Deployer

```bash
# Auto-detect profile from hostname
/opt/canary/bin/canary-deployer --auto-profile

# Explicit profile
/opt/canary/bin/canary-deployer --profile app-server

# Dry run (shows what would be created, no writes)
/opt/canary/bin/canary-deployer --profile app-server --dry-run

# Output: updates /opt/canary/config/canary-map.json with planted file paths + SHA-256
```

### Content Templates

Canary files must look realistic. Templates use Go's `text/template` engine:

```bash
# templates/credentials/aws_credentials.tmpl
[default]
aws_access_key_id     = AKIA{{.RandomAlpha 16}}
aws_secret_access_key = {{.RandomBase64 40}}
region = us-east-1
# Last rotated: {{.BlendedDate}}
```

```bash
# templates/configs/env_file.tmpl
# Application environment — {{.AppName}} {{.BlendedDate}}
DATABASE_URL=postgres://{{.RandomAlpha 8}}:{{.RandomBase64 16}}@db-prod.internal/{{.RandomAlpha 6}}
SECRET_KEY={{.RandomBase64 48}}
API_KEY={{.RandomHex 32}}
DEBUG=false
```

```bash
# templates/keys/ssh_private_key.tmpl
-----BEGIN OPENSSH PRIVATE KEY-----
{{.FakeSSHKeyBody}}
-----END OPENSSH PRIVATE KEY-----
```

**CRITICAL:** Always embed a unique sentinel marker (invisible to human readers) as a trailing comment or metadata field. This lets the system distinguish a canary read from a coincidental naming collision:

```bash
# Each file gets a unique UUID embedded as a hidden comment or metadata tag
# Example for env file:
# __CANARY_ID__={{.CanaryUUID}}  (appended as last line)

# For binary files: embed in extended attributes
setfattr -n user.canary_id -v "{{.CanaryUUID}}" /path/to/canary/file
```

### Template Rendering (Go)

```go
package deployer

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"text/template"
	"time"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
)

// TemplateData provides functions and data to Go text/template files.
type TemplateData struct {
	AppName    string
	BlendedDate string
	CanaryUUID  string
}

func (td TemplateData) RandomAlpha(n int) string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	return randomString(chars, n)
}

func (td TemplateData) RandomBase64(n int) string {
	buf := make([]byte, n)
	rand.Read(buf)
	return base64.StdEncoding.EncodeToString(buf)[:n]
}

func (td TemplateData) RandomHex(n int) string {
	buf := make([]byte, n/2)
	rand.Read(buf)
	return hex.EncodeToString(buf)
}

func (td TemplateData) FakeSSHKeyBody() string {
	buf := make([]byte, 256)
	rand.Read(buf)
	return base64.StdEncoding.EncodeToString(buf)
}

// RenderTemplate renders a canary file template and writes to disk.
func RenderTemplate(tmplPath, outputPath string, data TemplateData) error {
	tmpl, err := template.ParseFiles(tmplPath)
	if err != nil {
		return fmt.Errorf("parse template: %w", err)
	}

	f, err := os.Create(outputPath)
	if err != nil {
		return fmt.Errorf("create file: %w", err)
	}
	defer f.Close()

	return tmpl.Execute(f, data)
}
```

### Metadata Blending

```bash
# After creating canary file, blend its timestamps with neighbor files
NEIGHBOR=$(ls -t $(dirname $CANARY_PATH) | grep -v $(basename $CANARY_PATH) | head -1)
REF_TIME=$(stat -c %y "$NEIGHBOR")
touch -d "$REF_TIME" "$CANARY_PATH"

# Copy permissions and ownership from neighbor
REF_PERMS=$(stat -c %a "$NEIGHBOR")
REF_OWNER=$(stat -c %U "$NEIGHBOR")
REF_GROUP=$(stat -c %G "$NEIGHBOR")
chmod "$REF_PERMS" "$CANARY_PATH"
chown "$REF_OWNER:$REF_GROUP" "$CANARY_PATH"
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

## Access Monitoring

Canary file access detection uses Tetragon TracingPolicy targeting `security_file_open`. The policy YAML is generated by the canary-deployer from `canary-map.json` and applied via the Tetragon gRPC API or `kubectl apply`.

### eBPF Monitoring (Preferred) via Tetragon

Install Tetragon as a DaemonSet (Kubernetes) or systemd service (bare metal):

```bash
# Bare metal install
curl -LO https://github.com/cilium/tetragon/releases/latest/download/tetragon-linux-amd64.tar.gz
tar -xf tetragon-linux-amd64.tar.gz
install -m 755 tetragon /usr/local/bin/
```

Define a `TracingPolicy` that captures **all** file open events with raw args only — **no path filtering in eBPF:**

```yaml
# /etc/tetragon/policies/canary-file-watch.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: canary-file-access
spec:
  kprobes:
    - call: "security_file_open"
      syscall: false
      args:
        - index: 0
          type: "file"    # captures file path as raw bytes
      # NO selectors — NO matchArgs.
      # All file open events flow to the ring buffer as raw bytes.
      # Path matching against canary-map.json happens in the
      # Go userspace reader, not here.
```

```bash
# Reload policy after canary-map.json is updated
tetra tracingpolicy apply /etc/tetragon/policies/canary-file-watch.yaml
```

### Policy Generation from canary-map.json (Go)

The canary-deployer generates the Tetragon TracingPolicy YAML from the canary map and applies it on every rotation:

```go
func generateTetragonPolicy(canaryPaths []string) ([]byte, error) {
    tmpl := template.Must(template.ParseFiles(
        "config/tetragon-canary-policy.tmpl",
    ))
    var buf bytes.Buffer
    err := tmpl.Execute(&buf, canaryPaths)
    return buf.Bytes(), err
}
```

### Go Userspace Reader (Canary File Matching)

The Go process reads Tetragon's gRPC event stream and performs all filtering:

```go
package canarymon

import (
	"context"
	"encoding/json"
	"os"

	"github.com/cilium/tetragon/api/v1/tetragon"
	"google.golang.org/grpc"
)

// WatchCanaryFiles reads raw file-open events from Tetragon and
// filters them against the canary map. All logic is in userspace.
func WatchCanaryFiles(ctx context.Context, canaryMapPath string, alertFn func(map[string]interface{})) error {
	// Load canary paths from canary-map.json (reloaded on SIGHUP)
	canaryPaths := loadCanaryPaths(canaryMapPath)

	conn, _ := grpc.Dial("unix:///var/run/tetragon/tetragon.sock", grpc.WithInsecure())
	defer conn.Close()

	client := tetragon.NewFineGuidanceSensorsClient(conn)
	stream, _ := client.GetEvents(ctx, &tetragon.GetEventsRequest{})

	for {
		resp, err := stream.Recv()
		if err != nil {
			return err
		}

		kp := resp.GetProcessKprobe()
		if kp == nil {
			continue
		}

		// USERSPACE PATH MATCHING — eBPF only captured raw file path
		filePath := kp.GetArgs()[0].GetFileArg().GetPath()
		if _, isCanary := canaryPaths[filePath]; !isCanary {
			continue // Not a canary file — discard
		}

		proc := kp.GetProcess()
		alertFn(map[string]interface{}{
			"type":    "CANARY_FILE_ACCESS",
			"file":    filePath,
			"pid":     proc.GetPid().GetValue(),
			"uid":     proc.GetUid().GetValue(),
			"process": proc.GetBinary(),
		})
	}
}

func loadCanaryPaths(path string) map[string]bool {
	data, _ := os.ReadFile(path)
	var m struct {
		Canaries []struct {
			Path string `json:"path"`
		} `json:"canaries"`
	}
	json.Unmarshal(data, &m)
	result := make(map[string]bool)
	for _, c := range m.Canaries {
		result[c.Path] = true
	}
	return result
}
```

### inotify Fallback (No eBPF)

Used only when Tetragon is unavailable or fails verifier checks. The sentinel emits a `SENTINEL_DEGRADED` event so coverage reduction is visible:

```bash
#!/bin/bash
# /opt/canary/bin/inotify-watcher.sh
# Reads canary paths from canary-map.json and sets up watches
# NOTE: inotify covers canary file reads ONLY — not kill(), ptrace(), or all syscalls

CANARY_PATHS=$(jq -r '.canaries[].path' /opt/canary/config/canary-map.json)

inotifywait -m -e access,modify,attrib,delete,move \
  --format '%T %e %w%f %p' \
  --timefmt '%Y-%m-%dT%H:%M:%S' \
  $CANARY_PATHS 2>/dev/null | while read -r timestamp event file pid; do
    echo "{\"ts\":\"$timestamp\",\"event\":\"$event\",\"file\":\"$file\",\"pid\":\"$pid\",\"type\":\"CANARY_FILE_EVENT\"}" \
      >> /opt/canary/logs/access.log
    # Sentinel daemon picks up this log and signs/ships it
done
```

```bash
# Run as a systemd service
systemctl enable --now canary-inotify-watcher
```

---

## eBPF Program Constraints

All eBPF programs used by the file canary engine (via Tetragon TracingPolicies) must adhere to these constraints:

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
- Path matching or string comparison (no `matchArgs` selectors in TracingPolicies)
- Any filtering logic (no `if` branches based on file path content)
- Rule evaluation or alerting logic
- Network calls or map writes beyond the ring buffer
- Conditional branching based on file content

---

## Userspace Reader Responsibilities

The boundary between eBPF (kernel) and Go (userspace) is strict:

| Responsibility | Where it runs | Rationale |
|---|---|---|
| Capture raw file-open syscall args (path, pid, uid) | **eBPF** (Tetragon) | Minimal kernel surface area |
| Write raw bytes to ring buffer | **eBPF** (Tetragon) | Only output mechanism |
| Increment per-CPU event counter | **eBPF** (Tetragon) | Metrics only |
| Match file path against canary-map.json | **Go userspace** | Canary map changes at runtime (rotation) |
| Apply exclusions (known-safe processes) | **Go userspace** | Exclusion list changes at runtime |
| Detect bulk-read patterns (3+ canary files in 30s) | **Go userspace** (detection-engine) | Requires sliding window state |
| Detect metadata changes (chmod/chown on canary) | **Go userspace** | Needs cross-event correlation |
| Enrich events (process lineage, container context) | **Go userspace** | Requires procfs + K8s API |
| Sign and chain events (Ed25519 + Merkle) | **Go userspace** | Crypto must not run in kernel |
| Emit alerts (Kafka, sentinel pipeline) | **Go userspace** | Network I/O |

**Rule of thumb:** If the logic might change at runtime (canary paths, exclusions, rules), or if it requires state beyond the current syscall, it belongs in Go userspace — never in eBPF.

---

## eBPF Program Verification

Every Tetragon TracingPolicy must be verified before activation:

1. **Pre-load verification with `llvm-objdump`:** Before loading any eBPF program, run `llvm-objdump -d` on the compiled object to verify instruction count and call sites.

2. **Capture verifier log at load time:** Tetragon logs the kernel verifier output for each loaded program. Capture and store at:
   ```
   /opt/canary/logs/ebpf-verifier-<policy-name>-<timestamp>.log
   ```

3. **Fail-closed on verification failure:** If Tetragon reports a verifier error:
   - The canary file engine must **not assume eBPF monitoring is active**
   - Emit a `SENTINEL_EBPF_VERIFY_FAIL` event via the **out-of-band webhook** (not Kafka — Kafka may not be up yet)
   - Fall back to inotify-based monitoring (see Graceful Degradation)

---

## Graceful Degradation

If Tetragon is unavailable or a verifier error occurs, the file canary engine degrades gracefully — **never silently losing coverage:**

| Condition | Behavior |
|---|---|
| Tetragon not installed | Start with inotify fallback immediately |
| Tetragon installed but TracingPolicy fails verifier | Emit `SENTINEL_EBPF_VERIFY_FAIL` via OOB, fall back to inotify |
| Tetragon crashes at runtime | Emit `SENTINEL_DEGRADED`, switch to inotify within 5s |
| inotify also fails (watch limit hit) | Emit `SENTINEL_CRITICAL_DEGRADED` via OOB, alert ops |

### Degradation event

```go
event := map[string]interface{}{
    "type":             "SENTINEL_DEGRADED",
    "component":        "file-canary-engine",
    "monitoring_mode":  "inotify",     // was "tetragon"
    "coverage":         "canary_files_only", // inotify cannot monitor all syscalls
    "missing_coverage": []string{
        "non-canary file access (no full syscall capture)",
        "process lineage (no eBPF process tree)",
        "container-aware context",
    },
    "reason": "Tetragon unavailable — falling back to inotify",
}
```

### Key properties of degradation

- **Degradation must always be visible:** The `SENTINEL_DEGRADED` event is signed and shipped like any other event. The detection-engine adjusts its scoring when coverage is reduced.
- **inotify fallback covers canary file reads only** — it cannot capture all file opens system-wide, only watched canary paths. Bulk-read detection across non-canary files is lost.
- **Alert routing treats `SENTINEL_DEGRADED` as a P2 alert** — not P1 (canary files are still monitored), but urgent enough to investigate within 4 hours.
- **Never silent:** If the engine cannot determine its monitoring mode, it refuses to report healthy status.

---

## Exclusions

Some known-good processes may legitimately enumerate directories (backup agents, AV scanners) but should never read canary file *contents*. Differentiate `open()` from `stat()` in your rules:

```yaml
# config/exclusions.yaml
# Processes exempt from STAT/GETATTR alerts only (not from READ alerts)
stat_exclusions:
  - process: "bacula-fd"
    reason: "Backup agent stats all files"
  - process: "clamscan"
    reason: "AV scanner"

# These are NEVER exempt — any access is an alert
read_exclusions: []
execute_exclusions: []
```

---

## Canary Rotation

Rotate canary files on a randomized schedule (not a predictable cron) to prevent an attacker who knows the rotation schedule from acting during the rotation window:

```bash
# /opt/canary/bin/canary-rotator is a Go binary that:
# 1. Sleeps a random interval (0–3600s) to jitter the rotation time
# 2. Generates new canary files without removing old ones
# 3. Verifies new files are being monitored (sentinel confirms eBPF probes active)
# 4. Removes old canary files and updates canary-map.json

# Invoke from cron — the binary handles the random sleep internally:
0 */6 * * * /opt/canary/bin/canary-rotator --profile auto
```

---

## Stealth Hardening

- Register canary directories in `/etc/updatedb.conf` under `PRUNEPATHS` — this stops `locate` from indexing them, which looks natural (real sensitive dirs are often excluded).
- Add canary paths to `.gitignore` templates on app servers so they never accidentally get committed — realistic behavior.
- Set `immutable` flag on canary files to harden against accidental deletion while still triggering on reads:
  ```bash
  chattr +i /path/to/canary/file
  # Note: immutable flag DOES trigger inotify/eBPF on chattr removal attempts
  ```
- Periodically `touch` canary files from a known-safe process to update atime realistically (some attackers use stale atime as a canary-detection heuristic).

---

## Canary Map Schema

```json
{
  "version": "1.0",
  "generated_at": "2025-01-15T10:32:00Z",
  "host": "app-server-01",
  "canaries": [
    {
      "id": "c8f3a2d1-...",
      "path": "/home/deploy/.ssh/id_ed25519_deploy.old",
      "type": "ssh_key",
      "sha256": "a3b4c5d6...",
      "planted_at": "2025-01-15T10:32:00Z",
      "blended_mtime": "2024-11-03T14:21:00Z",
      "profile": "app-server"
    }
  ]
}
```

---

## Dependencies

- `tetragon` >= 0.11 OR `falco` >= 0.36 (eBPF monitoring)
- `inotify-tools` (fallback)
- `jq` (canary-map.json manipulation)
- `attr` (xattr support for hidden canary IDs)
- `chattr` / `lsattr` (immutable flag management)
- Go 1.26+ (build only — `canary-deployer` and `canary-rotator` are static binaries)
- `text/template` (stdlib — canary file generation)
- `encoding/json` (stdlib — canary-map.json)
- `gopkg.in/yaml.v3` (profile YAML parsing)
- Sentinel daemon must be running before deployer is invoked

---

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `inotify_add_watch: no space left` | Kernel inotify watch limit hit | `sysctl fs.inotify.max_user_watches=524288` |
| Tetragon policy not loading | Kernel lockdown blocks eBPF load | Verify lockdown mode; sign the eBPF prog |
| Alert fires on canary rotation | Cleaner process not in exclusion list | Add `canary-cleaner` to `stat_exclusions` |
| Canary file has wrong timestamps | touch ran before chown | Always chown before touch |
