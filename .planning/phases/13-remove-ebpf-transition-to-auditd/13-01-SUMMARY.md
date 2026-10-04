# Phase 13 - Wave 1 Summary (eBPF & Tetragon Removal)

## Work Performed
- Deleted `src/sentinel/internal/ebpf/` (C/Go BPF loaders).
- Refactored `src/sentinel/internal/selfmon/selfmon.go` to remove Tetragon/Kubernetes/Standalone eBPF modes.
- Simplified `DetectEnvironment` to only support `EnvAuditd` and `/proc` fallback.
- Updated `src/sentinel/cmd/sentinel-a/main.go` to remove Tetragon-specific liveness logic and killswitch unloads.
- Updated `deploy/sentinel.service` to remove `CAP_BPF` and `CAP_PERFMON` capabilities.
- Verified that no eBPF/Tetragon dependencies remain in `go.mod`.

## Self-Check
- [x] eBPF internal directory removed.
- [x] main.go and selfmon.go refactored.
- [x] systemd unit capabilities pruned.
- [x] `go mod tidy` executed.

## Next Steps
Proceed to **Wave 2: Core Auditd Infrastructure**, involving `auditctl` management and IPC synchronization.
