---
status: complete
phase: 21-hardening-defence
source:
  - 21-01-PLAN.md
  - 21-02-PLAN.md
started: "2026-05-08T11:12:00Z"
updated: "2026-05-08T11:30:00Z"
---

## Current Test

[testing complete]

## Tests

### 1. IN-001: Unique fallback IDs in aggregator
expected: |
  `extractAuditID` returns unique IDs for unparseable records to prevent buffer collision.
result: pass
verified_by: code inspection of `aggregator.go:171`

### 2. IN-002: Graceful killswitch exit
expected: |
  `pollKillSwitch` uses `cancel()` instead of `os.Exit(0)` to allow deferred cleanup.
result: pass
verified_by: code inspection of `main.go:546`

### 3. IN-004: Socket security documentation
expected: |
  Comment added to `server.go` explaining the implicit OS-level security of the Unix socket.
result: pass
verified_by: code inspection of `server.go:30`

### 4. IN-003: Secure entropy in FakeSSHKeyBody
expected: |
  `FakeSSHKeyBody` fails fast (`log.Fatalf`) if `rand.Read` fails, preventing predictable keys.
result: pass
verified_by: code inspection of `deployer.go:87`

### 5. IN-006: Restricted canary directory permissions
expected: |
  `MkdirAll` uses `0700` for canary directories instead of `0755`.
result: pass
verified_by: code inspection of `deployer.go:169`

### 6. IN-005: Config validation
expected: |
  `Config.Validate()` checks for required fields (`IngestionURL`, `KeySource`) and is called during `Load`.
result: pass
verified_by: code inspection of `config.go:104,112` and build verification.

## Summary

total: 6
passed: 6
issues: 0
pending: 0
skipped: 0
