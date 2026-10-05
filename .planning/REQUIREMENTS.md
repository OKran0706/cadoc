# Requirements: v1.4 Sentinel Hardening & Refactoring

## 1. Boot & Lifecycle (BOOT)
- [ ] **BOOT-01**: Move subcommand parsing (`audit-consume`) before `flag.Parse()` to ensure flags like `-config` are correctly initialized for both modes.
- [ ] **BOOT-02**: Implement a shared `http.Client` singleton with a configurable connection pool and reasonable timeouts.
- [ ] **BOOT-03**: Replace `os.Exit()` calls inside goroutines with context cancellation or `SIGTERM` self-signaling.
- [ ] **BOOT-04**: Ensure `wg.Wait()` is respected during shutdown to allow final events and heartbeats to be flushed.
- [ ] **BOOT-05**: Implement safe PID file management (directory creation, liveness checks, and overwrite prevention).

## 2. Security & Hardening (SEC)
- [ ] **SEC-01**: Audit and reorder initialization logic to ensure all privileged operations (e.g., `systemctl` calls, direct file access) occur BEFORE `DropCapabilitiesAfterInit()`.
- [ ] **SEC-02**: Ensure the maintenance ticket verifier is always checked before use to prevent nil pointer dereferences.
- [ ] **SEC-03**: Implement OOB alerts for invalid killswitch tickets.
- [ ] **SEC-04**: Add exponential retry backoff for transient Vault failures in the background poller.

## 3. Reliability & Error Handling (ERR)
- [ ] **ERR-01**: Eliminate all ignored errors (`_`) in `SignEvent`, `MarshalEnvelope`, and `exec.Command().Run()`.
- [ ] **ERR-02**: Log errors with full context and ensure invalid/unsigned payloads are never transmitted.
- [ ] **ERR-03**: Implement structured Vault error handling using `errors.Is` or typed errors instead of string matching.
- [ ] **ERR-04**: Update `verifyIngestion()` to validate HTTP status codes (fail on 5xx) and prefer a dedicated `/health` endpoint.

## 4. Resource Management (RES)
- [ ] **RES-01**: Audit all background goroutines (especially the Audit Socket server) to ensure they respect `ctx.Done()`.
- [ ] **RES-02**: Implement a 10-second timeout for the Audit Socket shutdown phase.

## Traceability
| REQ-ID | Phase | Status |
|--------|-------|--------|
| BOOT-01 | | |
| BOOT-02 | | |
| BOOT-03 | | |
| BOOT-04 | | |
| BOOT-05 | | |
| SEC-01 | | |
| SEC-02 | | |
| SEC-03 | | |
| SEC-04 | | |
| ERR-01 | | |
| ERR-02 | | |
| ERR-03 | | |
| ERR-04 | | |
| RES-01 | | |
| RES-02 | | |
