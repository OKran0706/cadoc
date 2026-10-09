---
plan: 19-01
phase: 19
status: complete
completed: "2026-05-08"
key_files:
  created: []
  modified:
    - src/sentinel/cmd/sentinel-a/audit_consume.go
    - src/sentinel/internal/auditmon/aggregator.go
---

# Summary: Plan 19-01 — Goroutine Leak & TOCTOU Race

## What Was Built

Fixed two critical concurrency bugs in the Auditd event pipeline:

**CR-001 — Goroutine leak in `handleSentinelConn`:**
- Replaced the `stopForwarding` channel with `context.WithCancel`. The derived context's `cancel()` (via `defer`) cleanly exits goroutine A via `ctx.Done()`. The `conn.Close()` (via `defer`) unblocks goroutine B's blocked `bufio.Scanner.Scan()` with an EOF.
- Added `context` import to `audit_consume.go`.
- Added nil-channel guard (`event, ok := <-agg.Events()`) to handle aggregator shutdown.

**CR-002 — TOCTOU race in `emitPartial`:**
- Restructured `emitPartial` to hold `a.mu` across the entire gate check: buffer delete + canaryMap lookup now happen under a single lock acquisition. The lock is released before the `emitChan` send (correct — prevents deadlock under backpressure).
- Eliminated the intermediate `found bool` variable in favour of a nil-path check.

## Verification
- `GOOS=linux GOARCH=amd64 go build ./cmd/sentinel-a/...` → exit 0 ✓
- No `stopForwarding` references remain in `audit_consume.go` ✓
- Single `a.mu.Lock()` / `a.mu.Unlock()` pair in `emitPartial` ✓
