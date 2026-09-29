---
wave: 1
depends_on: []
files_modified: ["src/sentinel/cmd/sentinel-a/main.go", "src/sentinel/cmd/sentinel-b/main.go", "src/sentinel/internal/sysutil/sysutil.go", "src/detection_engine/engine.py"]
autonomous: true
---

# Plan 02: Core Pipeline Hardening (Zero-Disk)

## Objective
Enforce strict zero-disk boundaries across Sentinel binaries and the Python Detection Engine.

## Requirements
- `REQ-2`: Sentinel leaves exactly 0 `.pem` files containing sensitive key material on disk.

## Tasks

<task>
<read_first>
- src/sentinel/internal/sysutil/sysutil.go
</read_first>
<action>
In `LoadTLSConfig`, modify `getCertData` to remove all fallback logic to `os.ReadFile(filePath)`. If `vaultLoc` is legitimately empty, return an explicit error defining that disk keys are forbidden!
</action>
<acceptance_criteria>
- `grep -A 2 "getCertData" src/sentinel/internal/sysutil/sysutil.go | grep ReadFile` fails (returns no results).
</acceptance_criteria>
</task>

<task>
<read_first>
- src/sentinel/cmd/sentinel-a/main.go
- src/sentinel/cmd/sentinel-b/main.go
</read_first>
<action>
1. Add `joinToken := flag.String("join-token", "", "Initial vault bootstrap token")` beside the other flags before `flag.Parse()`.
2. Map `os.Setenv("VAULT_TOKEN", *joinToken)`.
3. Modify `sysutil.UnwrapVaultToken` calls to use `*joinToken` instead of environment variables explicitly. 
</action>
<acceptance_criteria>
- `grep "join-token" src/sentinel/cmd/sentinel-a/main.go` returns successfully.
- `grep "join-token" src/sentinel/cmd/sentinel-b/main.go` returns successfully.
</acceptance_criteria>
</task>

<task>
<read_first>
- src/detection_engine/engine.py
</read_first>
<action>
1. Import `hvac` and configure a client `vault_client = hvac.Client(url=os.environ.get("VAULT_ADDR"), token=os.environ.get("VAULT_TOKEN"))`.
2. Inject Vault logic inside `DetectionEngine.start()` to fetch keys dynamically from `secret/data/canary/kafka`, and inject SSLContext bytes dynamically into `KafkaConsumer`.
</action>
<acceptance_criteria>
- `grep "hvac" src/detection_engine/engine.py` returns successfully.
</acceptance_criteria>
</task>

## Verification
- Syntactically verify Go codebase.
- Linter checks on `engine.py`.

## Must Haves
- Python must NOT write dynamically generated certificates to `/tmp` to instantiate `KafkaConsumer`.
