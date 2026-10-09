# Phase 13 Research: Remove eBPF Dependency

This research investigates the transition from a hybrid eBPF/Auditd monitoring model to a pure, live-injected Auditd model.

## Objectives
- [x] Research `auditctl` flags for live, memory-only directory watches.
- [x] Research Go patterns for Unix socket dialing with exponential backoff.
- [x] Identify methods for Sentinel daemon to detect `auditd` or plugin failure.
- [x] Map out eBPF/Tetragon dependencies in `src/sentinel`.

## Findings

### 1. auditctl for Memory-Only Rules
- **Direct Injection**: Use `auditctl -w <path> -p <perms> -k <key>` to add rules to the running kernel without writing to disk.
- **Non-Persistence**: Rules added via `auditctl` are volatile and lost on reboot or `auditd` restart. This aligns with the "Zero-Disk" constraint and ensures that no canary path configuration is left on the host after a service stop.
- **Cleanup**: `auditctl -W <path> -p <perms> -k <key>` removes a specific rule. `auditctl -D` removes all rules.
- **Verification**: `auditctl -l` lists currently active rules.

### 2. Go Unix Socket Dialing with Exponential Backoff
- **Pattern**: The `audit-consume` worker should use a robust dialing loop to wait for the main daemon's socket.
- **Logic**:
  ```go
  backoff := 100 * time.Millisecond
  for {
      conn, err := net.Dial("unix", "/run/canary/audit.sock")
      if err == nil {
          return conn, nil
      }
      time.Sleep(backoff)
      backoff *= 2
      if backoff > 5 * time.Minute {
          backoff = 5 * time.Minute
      }
  }
  ```
- **Socket Creation**: The main daemon must ensure `/run/canary/audit.sock` is initialized before the worker times out (though with the indefinite backoff, this is now safe).

### 3. Detecting auditd/Plugin Failures
- **Systemd Monitoring**: Use `github.com/coreos/go-systemd/v22/dbus` to monitor the `auditd.service` status.
- **Connection Health**: If the IPC socket connection is lost (`io.EOF`), the daemon assumes the audit stream is broken.
- **Alerting Strategy**: 
    - On disconnect: Emit `auditd_failed` to the Ingestion Service.
    - On reconnect: Emit `auditd_recovered`.

### 4. Codebase Dependencies for Removal
Based on a scan of the repository:
- **Tetragon**: `github.com/cilium/tetragon` used for eBPF event streaming.
- **eBPF**: `github.com/cilium/ebpf` for native program loading.
- **Files to Clean**:
  - `src/sentinel/internal/ebpf/`: Delete all C and Go BPF files.
  - `src/sentinel/cmd/sentinel-a/main.go`: Remove Tetragon initialization.
  - `deploy/sentinel.service`: Remove `CAP_BPF` and `CAP_PERFMON`.

## Validation Architecture

### 1. Static Verification
- **Import Check**: `grep -r "tetragon" src/` should return zero results.
- **Capability Check**: `systemctl show sentinel.service -p CapabilityBoundingSet` should not contain `CAP_BPF`.

### 2. Live Functional Verification
- **Rule Presence**: Start Sentinel and run `auditctl -l`. Confirm all canary watches are present.
- **Disk Cleanliness**: Verify `/etc/audit/rules.d/` contains no canary-specific rules.

### 3. End-to-End Telemetry
- **Trigger**: Access a canary file.
- **Verification**: Check Ingestion Service logs or Kafka for the "Bare Essentials" payload.

### 4. Resilience Loop
- **Test**: `systemctl stop auditd`. 
- **Verify**: Sentinel logs `auditd_failed` and enters retry loop.
- **Recovery**: `systemctl start auditd`.
- **Verify**: Sentinel logs `auditd_recovered` and rules are re-injected via `auditctl`.
