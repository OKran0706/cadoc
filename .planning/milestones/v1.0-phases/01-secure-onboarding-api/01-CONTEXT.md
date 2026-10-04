# Phase 1: Secure Onboarding API - Context

**Gathered:** April 1, 2026
**Status:** Ready for planning
**Source:** User Directive (Auto-Generated)

<domain>
## Phase Boundary
Build the API that accepts a `server_id`, mints a scoped HashiCorp Vault token, and returns a drop-in deployment command. Focus on Vault API integration, endpoint routing, and script wrapping.
</domain>

<decisions>
## Implementation Decisions

### API Integration
- Core function: Generate a Vault token exclusively for the provided `server_id`.
- The Vault token must be strictly scoped to prevent cross-contamination.
- Output MUST be a 1-line deployment script that an admin can paste onto the server.

### Security
- Zero file drops. The script must load the certs and keys purely into memory or the executing context, aligning with the zero-disk policy constraints.

### The Agent's Discretion
- Framework for the API (Go vs Python).
- Exact Vault policy definitions/role mapping details.
</decisions>

<canonical_refs>
## Canonical References

- `.planning/REQUIREMENTS.md` — Requirements mapping for pipeline
- `.planning/codebase/ARCHITECTURE.md` — Architecture
- `.planning/codebase/INTEGRATIONS.md` — Vault mapping
</canonical_refs>

<specifics>
## Specific Ideas
- The admin deployment command should ideally be a single line (e.g., `curl -sL https://canary-api/deploy | bash`).
</specifics>

<deferred>
## Deferred Ideas
- Active PVC watchdog expansions are deferred from this onboarding.
</deferred>
