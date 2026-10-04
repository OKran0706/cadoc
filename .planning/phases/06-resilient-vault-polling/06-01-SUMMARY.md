---
one_liner: Implemented resilient Vault polling with exponential backoff and jitter for Sentinel re-authentication.
status: complete
---

# 06-01 Summary: Resilient Vault Polling

## What Was Built
- **Re-Auth Loop**: Sentinel-A now enters a non-crashing loop when restarting without a join-token if authentication to Vault fails (e.g. 403 Forbidden).
- **Exponential Backoff**:
  - Initial delay: 10s
  - Multiplier: 2x
  - Max delay: 10m
  - Jitter: +/- 10%
- **Vault Client Enhancements**: Added `SetTLSConfig` and `LoginWithCert` to the Vault client wrapper to enable bootstrap via persisted mTLS certificates.
- **Cert Management**: `LoadTLSConfig` now returns raw PEM bytes, allowing the main process to persist them to `/var/lib/canary` after a successful Vault fetch.

## Key Decisions
- **Non-blocking Startup**: The service will wait indefinitely for Vault approval rather than crashing and relying on systemd restarts, reducing noise and providing better log context.
- **Jitter inclusion**: Essential for avoiding "thundering herd" issues when the Vault backend recovers.

## Self-Check: PASSED
- [x] `vault/client.go` contains `LoginWithCert`
- [x] `main.go` contains exponential backoff loop
- [x] `main.go` handles 403 status from Vault
- [x] `sysutil.go` returns raw cert bytes for persistence
- [x] All imports (`math/rand`, `path/filepath`) are present
