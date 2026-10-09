# Phase 15: Structured Error & Ingestion Hardening - Context

**Gathered:** 2026-04-23
**Status:** Decisions Locked

<domain>
## Phase Boundary

Eliminate all ignored errors (`_`) in the Sentinel-A event pipeline and replace brittle Vault string-matching error handling with typed sentinel errors. This phase is purely a code quality and correctness hardening — no behavioral changes to normal operation.

</domain>

<decisions>
## Implementation Decisions

### 1. Ignored Errors in Event Pipeline (ERR-01, ERR-02)
- **D-01**: **Log + Skip Policy**: If `s.SignEvent()` returns an error, log the error with context and skip the event. Do NOT transmit an unsigned or partial payload.
- **D-02**: **Log + Skip Policy**: If `signer.MarshalEnvelope()` returns an error, log the error with context and skip the transmission. Do NOT send nil/empty bytes.
- **D-03**: **No OOB for transient errors**: Signing/marshalling errors are transient. They should be logged with `log.Printf` only. OOB alerts are reserved for persistent security failures.
- **D-04**: **Pattern**: Replace all `envelope, _ := s.SignEvent(...)` and `payload, _ := signer.MarshalEnvelope(...)` occurrences with the following pattern:
  ```go
  envelope, err := s.SignEvent(event)
  if err != nil {
      log.Printf("[pipeline] Failed to sign event (type=%s): %v — skipping", eventType, err)
      return // or continue
  }
  payload, err := signer.MarshalEnvelope(envelope)
  if err != nil {
      log.Printf("[pipeline] Failed to marshal envelope (type=%s): %v — skipping", eventType, err)
      return // or continue
  }
  ```

### 2. Vault Error Classification (ERR-03)
- **D-05**: **Typed Sentinel Errors**: Define typed sentinel errors in `internal/vault/` package:
  ```go
  var ErrForbidden = errors.New("vault: forbidden (403)")
  var ErrNotFound  = errors.New("vault: secret not found (404)")
  ```
- **D-06**: **Wrap at source**: All Vault API methods that return HTTP errors must wrap the appropriate sentinel error using `fmt.Errorf("...: %w", ErrForbidden)` so callers can use `errors.Is`.
- **D-07**: **Replace string matching**: Replace `strings.Contains(err.Error(), "403")` in `pollKillSwitch` with `errors.Is(err, vault.ErrForbidden)`.
- **D-08**: **Scope**: Only `ErrForbidden` and `ErrNotFound` are required for this phase. Do not add a full error taxonomy — keep it minimal.

### 3. exec.Command Error Handling (ERR-01)
- **D-09**: **Log + Continue**: Replace `exec.Command("systemctl", "start", "canary-inotify-watcher").Run()` with:
  ```go
  if err := exec.Command("systemctl", "start", "canary-inotify-watcher").Run(); err != nil {
      log.Printf("[killswitch] Failed to start canary-inotify-watcher: %v (non-fatal)", err)
  }
  ```
- The kill switch activation proceeds regardless of whether the inotify fallback starts.

</decisions>

<canonical_refs>
## Canonical References

- `src/sentinel/cmd/sentinel-a/main.go` — All `_` ignores to fix; `pollKillSwitch` string matching to replace.
- `src/sentinel/internal/vault/` — Target for typed error definitions.
- `src/sentinel/internal/signer/` — `SignEvent` and `MarshalEnvelope` signatures (read before fixing callers).

</canonical_refs>

<code_context>
## Existing Code Insights

### Locations of `_` ignores in main.go
- `L147`: `envelope, _ := s.SignEvent(...)` — test-sign path (acceptable, exits after)
- `L229`: `envelope, _ := s.SignEvent(auditMap)` — auditmon handler (FIX)
- `L230`: `payload, _ := signer.MarshalEnvelope(envelope)` — auditmon handler (FIX)
- `L252`: `envelope, _ := s.SignEvent(capEvent)` — capability proof (FIX)
- `L253`: `payload, _ := signer.MarshalEnvelope(envelope)` — capability proof (FIX)
- `L315`: `envelope, _ := s.SignEvent(event)` — heartbeat loop (FIX)
- `L316`: `payload, _ := signer.MarshalEnvelope(envelope)` — heartbeat loop (FIX)
- `L418`: `envelope, _ := s.SignEvent(degEvent)` — kill switch degraded event (FIX)
- `L419`: `payload, _ := signer.MarshalEnvelope(envelope)` — kill switch degraded event (FIX)

### Vault string matching
- `L364`: `strings.Contains(err.Error(), "403")` in `pollKillSwitch` — replace with `errors.Is(err, vault.ErrForbidden)`

### exec.Command ignore
- `L399`: `exec.Command("systemctl", ...).Run()` — add error logging

</code_context>

<deferred>
## Deferred Ideas
- Full Vault error taxonomy (ErrUnauthorized, ErrServerError, etc.) — deferred to v1.5.
- Retry logic for transient signing failures — deferred (signing uses local key, so failures indicate key corruption, not transient errors).

</deferred>

---

*Phase: 15-structured-error-ingestion-hardening*
*Context gathered: 2026-04-23*
