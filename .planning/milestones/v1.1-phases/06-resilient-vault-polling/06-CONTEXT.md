# Phase 6: Resilient Vault Polling - Context

**Gathered:** 2026-04-17
**Status:** Ready for planning

<domain>
## Phase Boundary
Implement exponential backoff for re-authentication attempts to Vault when the service is blocked (403 status). This ensures Sentinel survives forced downtime or maintenance without manual intervention on the client VM.
</domain>

<decisions>
## Implementation Decisions

### Backoff Strategy
- **D-01:** Initial interval: 10s.
- **D-02:** Multiplier: 2.
- **D-03:** Max interval: 10m (600s).
- **D-04:** Jitter: +/- 10% on every sleep interval to prevent thundering herds on recovery.

### Re-Auth Mechanism
- **D-05:** Use the persisted mTLS cert from Phase 5 to interact with Vault's `auth/cert/login` endpoint.
- **D-06:** Detection of "Downtime Block" will be based on 403 Forbidden status codes from authentication attempts.

### Recovery
- **D-07:** Once re-auth succeeds, the loop breaks, fresh secrets are fetched, and normal startup resumes.
</decisions>

<canonical_refs>
## Canonical References
- `src/sentinel/cmd/sentinel-a/main.go` — Fallback boot path logic.
- `src/sentinel/internal/vault/client.go` — Vault client interface.
</canonical_refs>
