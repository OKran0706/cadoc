---
status: findings
phase: 18
files_reviewed: 17
findings:
  critical: 4
  warning: 9
  info: 6
  total: 19
---

# Code Review: Sentinel-A Daemon (Phase 18 — E2E Hardening)

> **Graph Context**: Analysis informed by graphify knowledge graph (371 nodes, 628 edges, 32 communities).
> Key clusters: `auditmon` ↔ `selfmon` ↔ `signer` form the hot path. `deployer_daemon` is a satellite cluster.

## Summary

The Sentinel-A daemon is architecturally sound with a clear separation between the Auditd consumer worker and the main daemon over a Unix socket. The cryptographic signing chain (Ed25519 + SHA256 Merkle) is correctly implemented. However, four critical issues were found: two goroutine leaks that could cause the daemon to miss events silently, one TOCTOU race in the aggregator's partial-emit path, and one ignored error on a security-sensitive call (`PersistPublicCerts`). Nine warnings cover dropped errors, missing timeouts, and incomplete input validation across the IPC boundary.

---

## Critical Issues

### CR-001: Goroutine Leak — `handleSentinelConn` forwarding goroutine is never cancelled
**File:** `src/sentinel/cmd/sentinel-a/audit_consume.go:75-95`
**Issue:** The "A. Forward events" goroutine selects on `agg.Events()` and `stopForwarding`. However, `stopForwarding` is closed by `defer close(stopForwarding)` **after** `handleSentinelConn` returns, which only happens **after** waiting on `errChan`. If the scanner goroutine (B) never sends to `errChan` (e.g. connection hangs indefinitely), the forwarding goroutine may block forever on the event channel with no way out.

More critically: if the `conn.Write` in the forwarding goroutine fails and sends to `errChan`, **and simultaneously** the scanner goroutine also fails, only one error is drained from `errChan` (buffered at 2, but only `<-errChan` is called once). The forwarding goroutine is then abandoned when `stopForwarding` closes — which is correct — but the scanner goroutine may still be running inside `bufio.Scanner.Scan()` with a closed connection.

**Impact:** Under high-throughput conditions, this leaks goroutines on every reconnect cycle. Over time this causes memory growth and potential deadlock if the `emitChan` fills.

**Fix:**
```go
// Pass a context to handleSentinelConn so goroutines can be cancelled
func handleSentinelConn(ctx context.Context, conn net.Conn, agg *auditmon.Aggregator) {
    defer conn.Close()
    errChan := make(chan error, 2)
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()

    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            case event := <-agg.Events():
                // ... write to conn
            }
        }
    }()
    // ...
}
```

---

### CR-002: TOCTOU Race — `emitPartial` acquires and releases mutex between read and write
**File:** `src/sentinel/internal/auditmon/aggregator.go:307-355`
**Issue:** `emitPartial` has a critical lock pattern bug. It acquires `a.mu`, deletes the buffer, and **releases the lock** on line 315. It then re-acquires `a.mu` on line 324 to read `a.canaryMap`. Between the two critical sections, another goroutine (e.g., `ProcessRecord`) could insert a new event with the same key, or `SetWatchPaths` could update `canaryMap`. This is a TOCTOU (time-of-check-to-time-of-use) race.

Specifically, `buf.pathsFields` is read outside the lock on lines 325-332 while `buf` was already deleted from `a.buffers` — but the buffer struct itself is still accessible via the local variable. The real issue is **double-locking without holding across the gate check**:

```go
// Lines 308-315: unlock after delete
a.mu.Lock()
buf, ok := a.buffers[key]
if !ok { a.mu.Unlock(); return }
delete(a.buffers, key)
a.mu.Unlock() // <-- unlocked here

// Lines 324-333: re-lock for canaryMap read
a.mu.Lock()              // <-- re-locked, but buf is already local copy
for _, fields := range buf.pathsFields {
    if a.canaryMap[p] { ... }  // canaryMap may have changed
}
a.mu.Unlock()
```

**Impact:** Under concurrent `SetWatchPaths` calls, an event targeting a path that was just removed from `canaryMap` could be emitted as a partial alert, or vice versa — a canary path added between the two locks might be missed.

**Fix:** Hold the mutex across the entire operation or do the canaryMap check before releasing:
```go
func (a *Aggregator) emitPartial(key string) {
    a.mu.Lock()
    defer a.mu.Unlock()

    buf, ok := a.buffers[key]
    if !ok { return }
    delete(a.buffers, key)

    if len(buf.paths) == 0 { return }

    var path string
    for _, fields := range buf.pathsFields {
        p := strings.Trim(fields["name"], "\"")
        if a.canaryMap[p] {
            path = p
            break
        }
    }
    if path == "" { return }
    // ... emit
}
```

---

### CR-003: Ignored error on `PersistPublicCerts` — security-sensitive
**File:** `src/sentinel/cmd/sentinel-a/main.go:135`
**Issue:** The return value of `sysutil.PersistPublicCerts` is silently discarded with `_`:
```go
_ = sysutil.PersistPublicCerts(stateDir, certCA, certClient)
```
If certificate persistence fails (e.g., disk full, wrong permissions on `stateDir`), the daemon continues running with certs only in memory. On the next restart — after a kill switch, a crash, or an upgrade — the daemon will enter the recovery path (`LoadPersistedCerts`) and **fail to authenticate**, causing a complete outage.

**Impact:** Silent certificate persistence failure leads to permanent lockout after next restart in production.

**Fix:**
```go
if err := sysutil.PersistPublicCerts(stateDir, certCA, certClient); err != nil {
    log.Fatalf("Failed to persist certificates to %s: %v — cannot guarantee recovery after restart", stateDir, err)
}
```

---

### CR-004: Ignored error on `SetTLSConfig` — Vault client may use stale TLS
**File:** `src/sentinel/cmd/sentinel-a/main.go:139`
**Issue:**
```go
_ = vaultClient.SetTLSConfig(tlsConfig)
```
`SetTLSConfig` calls `api.NewClient` internally (vault/client.go:67), which can fail if the TLS config is malformed. Silently ignoring this means the Vault client may continue using an old (or nil) TLS config, making all subsequent Vault operations (key fetches, killswitch polling) use incorrect credentials.

**Impact:** All downstream Vault-authenticated operations may fail silently or use unauthenticated connections.

**Fix:**
```go
if err := vaultClient.SetTLSConfig(tlsConfig); err != nil {
    log.Fatalf("Failed to apply TLS config to Vault client: %v", err)
}
```

---

## Warning Issues

### WR-001: `ic.Post` return value discarded in `selfmon.go`
**File:** `src/sentinel/internal/selfmon/selfmon.go:75,94`
**Issue:** Two calls to `ic.Post(ctx, payload)` discard their return value:
```go
ic.Post(ctx, payload)   // line 75
ic.Post(ctx, pay)       // line 94
```
Failed deliveries of `SELFMON_MODE_SELECTED` and `AUDIT_SUBSYSTEM_EVENT` events are silently dropped with no log output.

**Fix:**
```go
if err := ic.Post(ctx, payload); err != nil {
    log.Printf("[selfmon] Failed to post mode-selection event: %v", err)
}
```

---

### WR-002: Heartbeat goroutine exits on sign error instead of continuing
**File:** `src/sentinel/cmd/sentinel-a/main.go:364-366`
**Issue:**
```go
if err != nil {
    log.Printf("[selfmon] Failed to sign tamper event: %v", err)
    return   // <-- exits the entire heartbeat goroutine permanently
}
```
A transient signing error (e.g., a brief memory pressure spike) permanently kills the heartbeat goroutine. The `wg.Wait()` at shutdown will then complete immediately, but the daemon keeps running with no heartbeats, which the backend will interpret as a `SENTINEL_DOWN` alert after the threshold passes. The fix is to use `continue` instead of `return`.

**Fix:**
```go
if err != nil {
    log.Printf("[heartbeat] Failed to sign heartbeat: %v", err)
    continue  // not return
}
```

---

### WR-003: `auditctl ClearAll` uses wrong flag order
**File:** `src/sentinel/internal/auditmon/auditctl.go:57`
**Issue:**
```go
cmd := exec.Command("auditctl", "-k", m.key, "-D")
```
`auditctl -D` deletes **all** rules, ignoring `-k`. The `-k` flag is for filtering **list** output (`-l`), not for `–D`. This means every startup flushes **all audit rules** on the system, not just those with the `canary` key — potentially removing critical OS audit rules set by the sysadmin or other security tools.

**Fix:** Use `augenrules` or iterate rules by key. A safer approach:
```go
// List rules with this key, then delete each explicitly
cmd := exec.Command("sh", "-c",
    fmt.Sprintf("auditctl -l | grep ' -k %s' | while read rule; do auditctl -d $rule; done", m.key))
```
Or, for the simple case in test environments, document this limitation clearly.

---

### WR-004: `handleConnection` in `server.go` has no read deadline — can block indefinitely
**File:** `src/sentinel/internal/auditmon/server.go:92-113`
**Issue:** `bufio.Scanner.Scan()` on a Unix socket connection has no read timeout. If the worker process hangs or crashes without closing the socket, `handleConnection` will block forever on `scanner.Scan()`, holding the connection slot in `workers` and preventing cleanup.

**Fix:**
```go
// Set a read deadline that refreshes on each successful read
conn.SetReadDeadline(time.Now().Add(30 * time.Second))
for scanner.Scan() {
    conn.SetReadDeadline(time.Now().Add(30 * time.Second))
    // ... process line
}
```

---

### WR-005: `deployer_daemon` removes previous canaries before confirming new ones deployed
**File:** `src/sentinel/internal/deployer_daemon/daemon.go:43-53`
**Issue:** The loop deletes `activeCanaries` before calling `Deploy`. If `Deploy` fails (network outage, template error), the canary files have already been removed and `activeCanaries` is not updated. The daemon logs the error and loops again with an empty `activeCanaries`, meaning the system has **zero canary files deployed** until the next rotation cycle.

**Impact:** There is a window (potentially hours, up to `intervalSec + maxJitterSec`) where no canary files are present, leaving the system unprotected.

**Fix:** Reverse the order — deploy first, only remove old canaries on success:
```go
newCanaries, err := deployer.Deploy(profile, templateDir, false)
if err != nil {
    log.Printf("Deployer Daemon: error during deployment: %v — keeping existing canaries", err)
} else {
    // Remove old canaries only after successful new deployment
    for _, c := range activeCanaries {
        _ = os.Remove(c.Path)
    }
    activeCanaries = newCanaries
    // ... broadcast map
}
```

---

### WR-006: `workers` map in `server.go` is package-level global state
**File:** `src/sentinel/internal/auditmon/server.go:17-21`
**Issue:** `workers`, `workersMu`, and `currentMapMsg` are package-level globals. If `StartServer` is ever called more than once (e.g., in tests or if logic changes), state leaks across instances. This also makes unit testing difficult.

**Fix:** Move state into a `Server` struct returned by `StartServer`.

---

### WR-007: `getBlendedMtime` and `blendTimestamp` in deployer ignore empty directory edge case
**File:** `src/sentinel/internal/deployer/deployer.go:267-305`
**Issue:** `blendTimestamp` silently no-ops if the target directory has no other files (returns after first non-matching entry). `getBlendedMtime` returns `""` in the same case. An empty canary entry with `blended_mtime: ""` is then sent to the ingestion service, which may confuse downstream parsers expecting a valid RFC3339 timestamp.

**Fix:** Add explicit handling for the empty directory case and log a warning.

---

### WR-008: `audit_consume.go` scanner goroutine reads from a closed connection but error is not propagated to the forwarding goroutine
**File:** `src/sentinel/cmd/sentinel-a/audit_consume.go:98-116`
**Issue:** When the scanner goroutine sends to `errChan` and `handleSentinelConn` returns (closing `stopForwarding`), the forwarding goroutine may be mid-write to `conn`. Since `conn.Close()` is called by `defer`, the write may fail with a "use of closed network connection" error, sending a **second** error to `errChan`. Since `errChan` has capacity 2, the second error is buffered but never drained, which is fine functionally — but the forwarding goroutine's error path (line 88) may log a misleading "IPC Error" on reconnect.

**Fix:** Use `sync.Once` to close the error channel cleanly, or use context cancellation as suggested in CR-001.

---

### WR-009: `vault/client.go` error detection by string matching is fragile
**File:** `src/sentinel/internal/vault/client.go:159-167`
**Issue:**
```go
case strings.Contains(errStr, "403"):
    return "", fmt.Errorf("read secret %s: %w", path, ErrForbidden)
```
String-matching on `"403"` in the error message is fragile — it could match a path containing `"403"` (e.g., `secret/v1/http-403-responses`). The Vault SDK returns structured errors; use type assertions instead.

**Fix:**
```go
var respErr *api.ResponseError
if errors.As(err, &respErr) {
    switch respErr.StatusCode {
    case http.StatusForbidden:
        return "", fmt.Errorf("read secret %s: %w", path, ErrForbidden)
    case http.StatusNotFound:
        return "", fmt.Errorf("read secret %s: %w", path, ErrNotFound)
    }
}
```

---

## Info Issues

### IN-001: `extractAuditID` returns `"unknown"` — causes buffer key collision
**File:** `src/sentinel/internal/auditmon/aggregator.go:171-182`
**Issue:** If `extractAuditID` can't parse the raw data, it returns `"unknown"`. All unparseable records are then bucketed under the same key `"unknown"`, meaning fragments from different events will be merged together into one corrupted `eventBuffer`.

**Fix:** Return a random UUID or drop the record silently rather than using a fixed sentinel string.

---

### IN-002: `os.Exit(0)` in `pollKillSwitch` bypasses deferred cleanup
**File:** `src/sentinel/cmd/sentinel-a/main.go:538`
**Issue:** `os.Exit(0)` immediately terminates the process without running any `defer` statements — including `cancel()`, `wg.Wait()`, PID file cleanup, and the canary deployer's graceful shutdown. Canary files may be left deployed without updating the map.

**Fix:** Instead of `os.Exit(0)`, send a signal or cancel the root context:
```go
log.Println("KILL SWITCH TRIGGERED — SHUTTING DOWN")
cancel() // triggers graceful shutdown via ctx
```

---

### IN-003: `FakeSSHKeyBody` fallback uses predictable time-based entropy
**File:** `src/sentinel/internal/deployer/deployer.go:90-93`
**Issue:** The `rand.Read` fallback uses `time.Now().UnixNano()`, which produces very similar output if called in rapid succession, making canary content more distinguishable.

**Fix:** This fallback path should `log.Fatalf` — `crypto/rand` failure is a system-level issue that should halt deployment.

---

### IN-004: `server.go` accepts connections without any authentication
**File:** `src/sentinel/internal/auditmon/server.go:35-59`
**Issue:** Any local process can connect to `/run/canary/audit.sock` and send `EVENT` messages. There is no authentication on the Unix socket (e.g., peer credential check via `SO_PEERCRED`). An attacker with local code execution could inject fake tamper events.

**Info only** because `/run/canary` is mode 0700 (set in `main.go:201`) and the socket is mode 0660, which provides OS-level protection. However, this is worth documenting as an architectural assumption.

---

### IN-005: `config.go` has no validation of loaded config values
**File:** `src/sentinel/internal/config/config.go:76-105`
**Issue:** `Load` applies defaults but does not validate that required fields (`IngestionURL`, `KeySource`) are non-empty. A config file with a missing `ingestion_url` will produce an empty string that causes the ingest client to fail on every POST with a misleading error.

**Fix:** Add a `Validate()` method called after `Load`.

---

### IN-006: `deployer.go` target directory creation uses world-executable permissions
**File:** `src/sentinel/internal/deployer/deployer.go:170`
**Issue:**
```go
if err := os.MkdirAll(target.Path, 0755); err != nil {
```
`0755` makes the target directory world-readable and world-executable. Canary files inside (fake credentials, SSH keys) should not be browseable by unprivileged users on a shared system.

**Fix:** Use `0700` for canary directories to restrict listing to root.

---

## Graph-Informed Observations

From the knowledge graph (371 nodes, 628 edges):

| Cluster | Risk |
|---------|------|
| `auditmon` ↔ `selfmon` | High fan-in — `selfmon.Environment.String()` has INFERRED edges to 12+ callers; any change to environment detection logic propagates widely |
| `signer.Signer.SignEvent` | Central hub — called from 6 different packages; any locking bug here causes system-wide event loss |
| `deployer_daemon.removeOldCanariesBruteForce` | Isolated cluster — no unit tests inferred from graph; the `__CANARY_ID__` marker scanning logic is fragile |
| `ingestclient.Client.Post` | Leaf node — no retry logic; callers must implement their own retry policy but most don't (see WR-001) |

---

## Next Steps

```
/gsd-code-review-fix 18  — Auto-fix WR-001, WR-002, CR-003, CR-004 (safe mechanical fixes)
/gsd-verify-work 18      — Re-run E2E test to confirm fixes don't regress the pipeline
```
