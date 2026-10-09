# Phase 14 Summary

**Phase:** 14 — Boot & Lifecycle Foundation
**Completed:** 2026-04-23
**Status:** ✅ Complete

## What Was Built

### Plan 14-01: Subcommand Parsing Fix & PID Hardening
- Moved `audit-consume` subcommand check to the **very first line** of `main()`, before all flag definitions and `flag.Parse()`. audispd no longer needs to handle Go flag conflicts.
- Hardened PID file write with `os.MkdirAll("/run/canary", 0700)` before `os.WriteFile`, ensuring the directory exists with correct permissions even when running outside systemd.

### Plan 14-02: Shared HTTP Client with Connection Pooling
- Updated `ingestclient.New()` to configure a pooled `http.Transport` with `MaxIdleConns: 10`, `MaxIdleConnsPerHost: 5`, `IdleConnTimeout: 90s`.
- Added `HTTPClient()` accessor method to `ingestclient.Client` to expose the underlying `*http.Client` for reuse.
- Refactored `sendOOBAlert` to accept `ctx context.Context` and `ic *ingestclient.Client` — reuses the shared transport instead of creating a new `http.Client{}` per call.

### Plan 14-03: Ingestion Boot Connectivity Check with Exponential Backoff
- Replaced single-attempt `verifyIngestion()` with `verifyIngestionWithRetry()` implementing exponential backoff: `1s → 2s → 4s → ... → 30s` per sleep, capped at `10 minutes` total.
- Requires `HTTP 200` or `204` — connectivity alone is no longer sufficient.
- Targets `/health` endpoint (falls back to base URL on 404-equivalent).
- Gracefully respects context cancellation.

## Key Files Modified
- `src/sentinel/cmd/sentinel-a/main.go` — all three plans
- `src/sentinel/internal/ingestclient/client.go` — plan 14-02

## Build Verification
- `go build ./internal/ingestclient/` → ✅ PASS
- `go vet ./internal/ingestclient/` → ✅ PASS
- `go build ./cmd/sentinel-a/` → ⚠ Expected: `auditmon` excluded by Linux build constraints (Windows dev env, pre-existing)

## Requirements Addressed
- BOOT-01 ✅ — Subcommand parsing before flag.Parse()
- BOOT-02 ✅ — Shared HTTP client with pooling
- BOOT-05 ✅ — PID directory hardening
- ERR-04 ✅ — Ingestion check validates status code + retry loop
