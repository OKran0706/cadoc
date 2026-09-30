---
wave: 1
depends_on: []
files_modified: ["src/tools/onboarding-api/main.go", "src/tools/onboarding-api/vault.go"]
autonomous: true
---

# Plan 01: Build Secure Onboarding API

## Objective
Build a Go-based API service that receives a `server_id` payload, provisions a strictly scoped AppRole/Token in HashiCorp Vault, and returns a 1-line shell command that securely deploys and runs the Sentinel daemon without persisting secrets to disk.

## Requirements
- REQ-1

## Context & Architecture
- Code will be placed in `src/tools/onboarding-api/`. 
- Language: Go.

## Tasks

<task>
<read_first>
- src/sentinel/internal/config/config.go
</read_first>
<action>
Create `src/tools/onboarding-api/main.go` containing a standard Go HTTP server listening on port 8080. Create a `/v1/deploy` POST endpoint. The JSON payload struct must be `type DeployRequest struct { ServerID string \`json:"server_id"\` }`.
</action>
<acceptance_criteria>
- `grep "func main" src/tools/onboarding-api/main.go` returns successfully.
- `grep "ServerID" src/tools/onboarding-api/main.go` returns the struct definition.
</acceptance_criteria>
</task>

<task>
<read_first>
- src/sentinel/internal/sysutil/sysutil.go
</read_first>
<action>
Create `src/tools/onboarding-api/vault.go`. Implement `func CreateScopedToken(serverID string) (string, error)`. Call Vault's HTTP APIs (using environment variables `VAULT_ADDR` and `VAULT_TOKEN`) to hit `/v1/auth/token/create` creating a strictly scoped, short-lived token wrapper explicitly for this specific Sentinel. Include the Vault struct responses natively.
</action>
<acceptance_criteria>
- `grep "CreateScopedToken" src/tools/onboarding-api/vault.go` returns successfully.
</acceptance_criteria>
</task>

<task>
<read_first>
- src/tools/onboarding-api/main.go
- src/tools/onboarding-api/vault.go
</read_first>
<action>
Update the `/v1/deploy` endpoint handler in `src/tools/onboarding-api/main.go`. Call `CreateScopedToken(req.ServerID)`. If successful, write an HTTP 200 plain text response matching this exact shell one-liner:
`curl -sL https://canary-binary-store/sentinel -o /tmp/sentinel && chmod +x /tmp/sentinel && VAULT_TOKEN=%s /tmp/sentinel -id %s`
Where the first `%s` is the Vault token and the second `%s` is the `ServerID`.
</action>
<acceptance_criteria>
- `grep "curl -sL" src/tools/onboarding-api/main.go` returns successfully.
</acceptance_criteria>
</task>

## Verification
- Compile `src/tools/onboarding-api/main.go` successfully.
- Check that the `curl` response output cleanly populates the zero-disk Vault variables.

## Must Haves
- The token returned in the curl payload MUST be dynamically generated from Vault APIs.
- No files aside from main.go and vault.go are written to disk.
