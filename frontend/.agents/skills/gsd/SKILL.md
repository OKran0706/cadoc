---
name: gsd
description: Workflows and commands for the RIDZ GSD (Get Shit Done) Playbook. Use this skill when planning, building, reviewing, securing, or validating features using testable invariants, phased execution, TDD, and bounded code reviews.
---

# RIDZ GSD Playbook Skill

This skill guides and automates feature delivery using the RIDZ GSD methodology within the `sentinal-dashboard` workspace.

## Configuration
Configuration is stored in `gsd.config.json` at the workspace root:
```json
{
  "mode": "interactive",
  "workflow": {
    "research": true,
    "plan_check": true,
    "verifier": true,
    "nyquist_validation": true,
    "code_review": true,
    "code_review_depth": "deep",
    "security_enforcement": true,
    "security_asvs_level": 2,
    "security_block_on": "medium",
    "tdd_mode": true
  }
}
```

---

## Command Handlers

### 1. `/gsd-spec-phase <N> [feature]` — Specification & Invariants
- Determine the **Risk Tier** (Trivial, Low, Medium, High).
- Define requirements strictly as testable invariants:
  - Format: `INV-1: <Requirement statement (must always / must never)>`
  - Scope: Caller roles, rate limits, size constraints, data isolation.
  - Pull matching checklists from `.agents/rules/gsd-playbook.md` (e.g., Auth, RBAC/IDOR, Concurrency, Performance).
  - Explicitly mark `OUT OF SCOPE` items.
  - Flag all ambiguous edge cases for discussion rather than guessing.

### 2. `/gsd-discuss-phase <N>` — Decision Matrix
- Interview the user or address gray areas systematically:
  1. **Partial failure:** What happens if step 2 of 3 fails (e.g. backend succeeds, cache update fails)?
  2. **Idempotency & duplicates:** What happens if the same request arrives twice or concurrently?
  3. **Deleted/expired state:** What if the target entity (agent, alert, key) is deleted or expired mid-flow?
  4. **Authorization:** Exactly which role is permitted (platform_owner, tenant_admin, analyst)?
  5. **Limits & bounds:** Max sizes, pagination limits, rate limits?
  6. **Data migrations / backfills:** How do existing records behave?
- Record finalized decisions as `D-01`, `D-02`, etc.

### 3. `/gsd-plan-phase <N>` — Implementation Blueprint
- For every invariant (`INV-x`) and decision (`D-xx`):
  - State the **Enforcement Point** (database constraint, route middleware, API client validator, component guard).
  - State the **Test** that proves the invariant.
- Threat Model:
  - Authn / session tokens
  - Authz / IDOR / tenant boundary
  - Input validation (Zod schema bounds, type guards)
  - Secrets / PII leakage prevention
  - Concurrency & race conditions
- Scope: Target ~3–6 files changed per phase.
- Wave 1: Design failing tests first (TDD).

### 4. `/gsd-execute-phase <N>` — TDD Build
- **Wave 1 (Red):** Write failing test suite covering all critical invariants. Verify tests fail for expected reasons.
- **Wave 2 (Green):** Implement minimum code changes required to satisfy invariants and pass tests.
- Re-use existing patterns from `src/lib/api.ts`, `src/services/`, and `src/components/`.

### 5. `/gsd-code-review <N> [--fix]` — Bounded Review
- Review **ONLY** against this phase's invariants (`INV-x`), decisions (`D-xx`), and threat model.
- Each finding MUST include:
  - `file:line`
  - Severity: `Critical | High | Medium`
  - Concrete failure scenario: `Input / State -> Bad outcome`
  - Actionable fix
- **Constraints:**
  - No stylistic or cosmetic nits.
  - Capped at maximum 15 findings.
  - If `--fix` is passed, automatically implement verified fixes for Critical and High findings.

### 6. `/gsd-secure-phase <N>` — Threat Model & ASVS Verification
- Verify that every mitigation specified in the threat model is present in code:
  - API keys / tokens not exposed in client bundles or logs.
  - Route permissions and tenant isolation enforced server-side.
  - SQL injection and XSS defenses verified.
- Return explicit status: `SECURED` or list blocking vulnerabilities.

### 7. `/gsd-validate-phase <N>` — Invariant Coverage
- Audit that 100% of defined `INV-x` requirements have an automated test asserting their validity.
- Close any gaps before proceeding to UAT.

### 8. `/gsd-verify-work <N>` — User Acceptance & Edge Cases
- Test the feature in realistic conditions (including using browser subagents or direct test calls).
- Must execute negative edge cases:
  1. Double-submit / duplicate trigger
  2. Unauthorized user / invalid token
  3. Oversized or malformed payload
  4. Expired or decommissioned target entity

### 9. `/gsd-extract-learnings <N>` — Knowledge Persistence
- Extract architectural insights, edge cases, and pitfalls discovered during the phase.
- Persist learnings into the workspace or knowledge items so subsequent phases do not repeat the same bug classes.

### 10. `/gsd-settings [key] [value]` — Configuration Management
- Read or update configuration options in `gsd.config.json`.
- When invoked without arguments, print current active settings.
