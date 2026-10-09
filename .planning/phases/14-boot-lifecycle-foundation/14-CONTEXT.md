# Phase 14: Boot & Lifecycle Foundation - Context

**Gathered:** 2026-04-23
**Status:** Decisions Locked

<domain>
## Phase Boundary

Harden the Sentinel-A daemon's entry point, networking layer, and process management. Focus on reliable bootstrapping, shared resource management, and clean subcommand isolation.

</domain>

<decisions>
## Implementation Decisions

### 1. Networking (HTTP Client)
- **D-01**: **Shared Ingest Client**: Refactor `internal/ingestclient` to provide a shared, pooled `http.Client`.
- **D-02**: **Connection Pooling**: Configure `MaxIdleConns` and `IdleConnTimeout` to handle frequent, small heartbeat and event bursts.
- **D-03**: **Context Support**: Every HTTP call must accept and respect `context.Context` for graceful shutdown.

### 2. Bootstrapping & Flags
- **D-04**: **Early Subcommand Check**: Move the `audit-consume` check to the very top of `main()`, before `flag.Parse()`.
- **D-05**: **Flagless Worker**: The `audit-consume` worker will remain flagless; any necessary config must be passed via environment variables or shared via the main daemon if needed in the future.

### 3. Ingestion Connectivity
- **D-06**: **Strict Health Validation**: `verifyIngestion` must validate for both TCP connectivity and a `200 OK` (or `204 No Content`) status code.
- **D-07**: **Boot Retry Loop**: Implement an exponential backoff retry loop during the initial ingestion check, capped at a maximum of 10 minutes before failing closed.

### 4. Process Management
- **D-08**: **PID File Policy**: Overwrite the PID file at `/run/canary/sentinel-a.pid` on startup. Since the service is managed by systemd, we rely on systemd for primary process liveness, but maintain the PID file for auxiliary monitoring scripts.
- **D-09**: **Directory Safety**: Ensure `/run/canary` is created with proper permissions (`0700`) before writing the PID file.

</decisions>

<canonical_refs>
## Canonical References

### System Integration
- `deploy/sentinel.service` — Reference for `Restart=always` and `StateDirectory`.
- `src/sentinel/cmd/sentinel-a/main.go` — Target for refactoring.
- `src/sentinel/internal/ingestclient/` — Target for HTTP client pooling.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `sysutil.IsCommandAvailable` — For pre-flight checks.
- `ingestclient.New` — To be updated for pooling.

### Hardening Targets
- `main.go:L50-54`: Subcommand check (move up).
- `main.go:L198`: Ingestion check (add loop/status validation).
- `main.go:L211`: PID file writing (harden directory check).

</code_context>

<deferred>
## Deferred Ideas
- Dynamic configuration reloading (SIGHUP) — deferred to v1.5.
- PID liveness verification (manual `os.FindProcess`) — deferred as systemd handles this.

</deferred>

---

*Phase: 14-boot-lifecycle-foundation*
*Context gathered: 2026-04-23*
