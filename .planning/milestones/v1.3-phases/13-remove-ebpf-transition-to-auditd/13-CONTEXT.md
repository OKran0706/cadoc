# Phase 13: Remove eBPF Dependency (Transition to Auditd) - Context

**Gathered:** 2026-04-21
**Status:** Decisions Locked

<domain>
## Phase Boundary

Eliminate all eBPF telemetry hooks and dependencies from the Sentinel daemon. Transition to a 100% `auditd`-based monitoring model where the Sentinel daemon acts as the aggregator and controller for a separate, lightweight `audit-consume` worker.

</domain>

<decisions>
## Implementation Decisions

### Process & IPC Architecture
- **D-01**: **Decoupled Architecture**: Maintain the separate process model. The `audit-consume` worker runs as an `audispd` plugin, while the main Sentinel daemon runs as a systemd service.
- **D-02**: **Worker-Side Filtering**: The `audit-consume` worker is responsible for filtering audit events against the "Canary Map" (Stealth Registry).
- **D-03**: **IPC Synchronization**: The main daemon will "push" Canary Map updates to the worker over the Unix socket (`/run/canary/audit.sock`). The worker must keep this map in-memory only.

### Audit Rule Management
- **D-04**: **Live Memory Injection**: Use `auditctl` to manage watches dynamically. Do NOT write persistent rules to `/etc/audit/rules.d/`.
- **D-05**: **Runtime Cleanup**: Sentinel must ensure that injected rules are cleaned up on graceful shutdown or rotation.

### Resilience & Telemetry
- **D-06**: **Liveness Signaling**: If the connection to `auditd` (via the worker) is lost, Sentinel must emit an `auditd_failed` event to the Ingestion Service.
- **D-07**: **Self-Healing**: Implement an exponential backoff retry loop for the IPC connection.
- **D-08**: **Recovery Signaling**: Upon successful reconnection/restart of the audit stream, emit an `auditd_recovered` event.

### Event Schema
- **D-09**: **Bare Essentials**: Telemetry payloads should be stripped to the minimum required for detection: `timestamp`, `event_type`, `path`, `pid`, `uid`, and `action`. Avoid raw audit string forwarding.

</decisions>

<canonical_refs>
## Canonical References

### System Tools
- `man auditctl` — Reference for live rule injection flags.
- `src/sentinel/cmd/sentinel-a/audit_consume.go` — Current worker implementation to be enhanced.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/sentinel/cmd/sentinel-a/audit_consume.go`: Existing IPC dialer and aggregator logic.
- `src/sentinel/internal/deployer/deployer.go`: Source of the Canary Map that needs to be pushed to the worker.

### Removal Targets
- `src/sentinel/internal/ebpf/`: Entire directory to be deleted.
- `src/sentinel/internal/engine/engine_ebpf.go`: Telemetry hooks to be removed.

</code_context>

<deferred>
## Deferred Ideas
- Multi-worker load balancing (if auditd stream exceeds single-core processing).
- Advanced BPF-based tamper protection for the Auditd process itself (deferred until a "Security Hardening" phase).

</deferred>

---

*Phase: 13-remove-ebpf-transition-to-auditd*
*Context gathered: 2026-04-21*
