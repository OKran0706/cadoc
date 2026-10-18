<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:gsd-playbook-rules -->
# RIDZ GSD Playbook Enforcement

All development in this repository must follow the RIDZ GSD Playbook guidelines defined in [.agents/rules/gsd-playbook.md](.agents/rules/gsd-playbook.md) and configured in [gsd.config.json](gsd.config.json):

1. **The Invariants Rule:** Features must be defined as numbered invariants (`INV-1`, `INV-2`) with explicit enforcement points and tests before implementation begins.
2. **Phase Boundary:** Scope each development phase to a single risk boundary and ~3–6 files changed.
3. **TDD Mode (Wave 1):** Write failing invariant tests first before implementing write paths, authorization checks, or state transitions.
4. **Bounded Code Review:** Code review must evaluate ONLY against the phase's invariants (`INV-x`), decisions (`D-xx`), and threat model. Every finding must specify `file:line`, a concrete failure scenario (input -> bad outcome), and severity. No stylistic nits. Max 15 findings.
5. **Security & Threat Model:** Verify ASVS Level 2 mitigations (authentication, authorization/IDOR, tenant isolation, input validation, rate limits, PII protection).
6. **Verification (UAT):** Verify flows end-to-end including negative paths: double-submit, unauthorized access, boundary/oversized payloads, and expired state.
<!-- END:gsd-playbook-rules -->

