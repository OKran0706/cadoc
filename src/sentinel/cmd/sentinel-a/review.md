Viewed audit_consume.go:73-112
Listed directory auditmon
Viewed aggregator.go:1-394
Viewed server.go:1-125

I've completed a **Deep Code Review** of `audit_consume.go` and its core dependencies in `internal/auditmon/`.

This review follows the event flow from raw Auditd records to the final signed telemetry, focusing on the IPC (Inter-Process Communication) and reassembly logic.

### [Deep Review] `audit_consume.go` + `internal/auditmon/`

| Severity | Category | Finding |
| :--- | :--- | :--- |
| **HIGH** | **Logic/Protocol** | **Space-in-Path Protocol Breakage**: The IPC protocol uses space as a delimiter (Line 78 in `audit_consume.go`). If a file path contains a space, the server-side `SplitN` (Line 101 in `server.go`) will misalign the fields, likely causing the "Operation" (READ/WRITE) to be replaced by part of the filename. |
| **MEDIUM** | **Security/Audit** | **Brittle Rename Logic**: `aggregator.go` (Line 218) assumes a fixed index for Rename paths (`index 2` and `index 3`). Auditd record order is not guaranteed. If a `CWD` or `PATH` record for a symlink is interleaved, the source/destination paths will be swapped or lost. |
| **MEDIUM** | **Robustness** | **Manual Field Extraction**: `aggregator.go` (Line 327) uses custom string searching (`strings.Index`) to extract audit fields instead of using the `auparse` library's built-in key-value mapping. This is prone to errors if field values contain '=' or escaped characters. |
| **LOW** | **Performance** | **Janitor Goroutine Leak**: The `Aggregator` (Line 77) starts a `janitor` goroutine that listens on `stopChan`. However, `stopChan` is never closed, which would lead to a goroutine leak if the Aggregator were ever restarted or re-initialized. |

---

### Detailed Findings & Dependency Analysis

#### 1. IPC Protocol Vulnerability
The communication between the worker and the main process is currently:
`EVENT <ID> <CONFIDENCE> <PID> <PATH> <OP> [DESTPATH]`
- **The Issue:** If `event.Path` is `"/var/lib/my secret.txt"`, the server in `server.go` splits this into:
    - `parts[4]` = `"/var/lib/my"`
    - `parts[5]` = `"secret.txt"` (This should have been the Operation!)
- **Recommendation:** Use a more robust format like JSON, or use a non-space delimiter (like a null byte `\x00` or a tab) to separate fields.

#### 2. Reassembly Logic (Aggregator)
The `Aggregator` correctly handles the interleaving of Auditd records using the unique `AuditID`.
- **Worker-side Filtering (Efficiency):** `Aggregator.isComplete` (Line 169) performs filtering against the `canaryMap` before the event is even shipped over IPC. This is a very efficient design that prevents the Unix socket from being flooded with noise from non-canary files.
- **Race Conditions:** Access to `canaryMap` and `buffers` is correctly protected by `sync.Mutex` in both the worker (`aggregator.go`) and the server (`server.go`).

#### 3. State Management (The "Replay" Brain)
In `server.go`, the `currentMapMsg` cache (Line 20) is a "smart" feature. It ensures that if the worker crashes and reconnects, it immediately receives the latest list of files to watch without waiting for the next global update. This is a critical "self-healing" mechanism for the telemetry pipeline.

#### 4. Audit Logic Gaps
- **Syscall Mapping:** `identifyOp` (Line 370) covers the basics (Read/Write/Rename). However, it misses `SYMLINK`, `LINK`, and `MKNOD`. An attacker could bypass "FILE_WRITE" monitoring by creating a hard link to a canary and modifying that instead.

---

### Suggested Fix: Robust IPC
I recommend updating the IPC line format to use **Tab-Separated Values (TSV)** or **JSON** to safely handle filenames with spaces.

**Would you like me to refactor the IPC protocol to use JSON or TSV to prevent the space-in-path issue?**