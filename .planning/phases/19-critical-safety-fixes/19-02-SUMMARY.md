---
plan: 19-02
phase: 19
status: complete
completed: "2026-05-08"
key_files:
  created: []
  modified:
    - src/sentinel/cmd/sentinel-a/main.go
---

# Summary: Plan 19-02 — Ignored Security-Sensitive Errors

## What Was Built

Fixed two silently-ignored errors in `main.go` with security-sensitive consequences:

**CR-003 — `PersistPublicCerts` error ignored:**
- Changed `_ = sysutil.PersistPublicCerts(...)` to a proper `if err := ...; err != nil { log.Fatalf(...) }`.
- Added a success log line confirming the write path.
- Rationale: if certs are not persisted, the next daemon restart hits `LoadPersistedCerts` → fails → permanent lockout.

**CR-004 — `SetTLSConfig` error ignored:**
- Changed `_ = vaultClient.SetTLSConfig(tlsConfig)` to `if err := ...; err != nil { log.Fatalf(...) }`.
- Rationale: `SetTLSConfig` internally calls `api.NewClient`; on failure the Vault client retains the old/nil TLS config and all subsequent calls silently use incorrect credentials.

## Verification
- `GOOS=linux GOARCH=amd64 go build ./cmd/sentinel-a/...` → exit 0 ✓
- `grep "_ = sysutil.PersistPublicCerts" main.go` → no results ✓
- `grep "_ = vaultClient.SetTLSConfig" main.go` → no results ✓
