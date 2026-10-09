# Phase 15 Summary

**Phase:** 15 — Structured Error & Ingestion Hardening
**Completed:** 2026-04-23
**Status:** ✅ Complete

## What Was Built

### Plan 15-01: Typed Vault Sentinel Errors (vault/client.go)
- Added `ErrForbidden = errors.New("vault: forbidden (403)")` and `ErrNotFound = errors.New("vault: not found (404)")`.
- Centralized HTTP status string inspection inside `GetSecretField` — wraps the opaque Vault SDK error with the appropriate sentinel error using `fmt.Errorf("...: %w", ErrForbidden/ErrNotFound)`.
- All callers above the vault package boundary can now use `errors.Is(err, vault.ErrForbidden)`.

### Plan 15-02: Eliminate _ Ignores in Event Pipeline (main.go)
- **Vault 403 string matching removed**: `strings.Contains(err.Error(), "403")` → `errors.Is(err, vault.ErrForbidden)` in `pollKillSwitch`.
- **auditmon handler**: Both `SignEvent` and `MarshalEnvelope` now log+skip on error (never sends unsigned payload).
- **Capability proof event**: Chained `else if` pattern — skips transmission on any signing/marshalling failure.
- **Heartbeat loop**: `continue` on signing/marshalling failure — loop keeps running, just skips that tick.
- **Kill switch DEGRADED event**: Chained `else if` pattern — skips on failure but kill switch activation still proceeds.
- **exec.Command**: `canary-inotify-watcher` start error now logged as `(non-fatal)`.

## Verification Results
- `payload, _` count: **0** ✅
- `envelope, _` count: **1** ✅ (test-sign path only — exits immediately after)
- `errors.Is(err, vault.ErrForbidden)` present ✅
- `go build ./internal/vault/` → **PASS** ✅
- `go vet ./internal/vault/` → **PASS** ✅
- `go build ./internal/ingestclient/` → **PASS** ✅

## Key Files Modified
- `src/sentinel/internal/vault/client.go` — plan 15-01
- `src/sentinel/cmd/sentinel-a/main.go` — plan 15-02

## Requirements Addressed
- ERR-01 ✅ — exec.Command error logged
- ERR-02 ✅ — No invalid payloads transmitted (log+skip on all pipeline errors)
- ERR-03 ✅ — Typed vault errors, errors.Is used at call site
