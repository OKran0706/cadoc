# Phase 5: Hybrid Credential Persistence - Context

**Gathered:** 2026-04-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Modify Sentinel's Vault credential flow to persist `ca.crt` and `mtls.crt` as raw PEM files to `/var/lib/canary/`, keep `mtls.key` strictly in memory, and add a fallback re-authentication path using persisted certs when no `--join-token` is provided.
</domain>

<decisions>
## Implementation Decisions

### Cert Storage Format
- **D-01:** Store `ca.crt` and `mtls.crt` as separate raw PEM files under `/var/lib/canary/`.

### Vault Re-auth
- **D-02:** Vault TLS certificate auth backend will be configured externally by the user. Sentinel's code should attempt cert-based auth when `--join-token` is absent but disk certs are present.

### Key Rotation
- **D-03:** Overwrite disk certs atomically using write-to-temp + rename pattern to avoid corruption on crash.

### Prior Decisions (Phase 4)
- **D-04:** `/var/lib/canary/` is auto-provisioned via systemd `StateDirectory=canary`. No manual directory creation needed.
</decisions>

<canonical_refs>
## Canonical References

### Existing Code
- `src/sentinel/internal/vault/client.go` — Vault client (Unwrap, GetSecretField)
- `src/sentinel/internal/sysutil/sysutil.go` — LoadTLSConfig (currently rejects disk fallback)
- `src/sentinel/cmd/sentinel-a/main.go` — Main boot flow with --join-token flag
</canonical_refs>
