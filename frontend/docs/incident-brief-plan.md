# AI Incident Brief — implementation contract

Risk: Medium for offline analysis; High boundary for the existing containment action. No backend, model calls, API keys, live telemetry ingestion, or automatic response is in scope. Existing uncommitted HUD work is the starting point.

## Invariants, enforcement, and tests

| Invariant | Enforcement | Proof |
| --- | --- | --- |
| INV-1: Evidence and timeline entries must come from the selected incident's validated telemetry; missing data must never become fabricated facts. | `explainIncident`, signal/event schemas | Functional tests for all six alert types; missing/malformed data; changed telemetry changes output. |
| INV-2: Identical inputs must produce identical briefs, including IDs and timestamps. Summary time is detection time with site timezone and UTC. | Pure engine; explicit snapshot time | Deep equality, timezone/date boundary, invalid timestamp tests. |
| INV-3: ATT&CK mappings require matching signals. Confidence counts independent matching sensors only (1 Low, 2 Medium, 3+ High), not duplicates or unrelated evidence. | Declarative rule matchers | Each rule, duplicate sensor, unrelated signal, no match, heartbeat-only Unmapped tests. |
| INV-4: Runtime-invalid output must never render. Optional sections disappear when empty. | Zod output contract and panel guard | Invalid URL, bounds, missing geo, missing telemetry tests and browser checks. |
| INV-5: Blast radius uses actual shared cluster/VPC/facility/country, excludes self and other tenants, and is labelled potential exposure rather than confirmed compromise. | Engine peer filter; shared selected-node ID | Relationship/status/scoping tests; browser peer selection and highlight. |
| INV-6: Only an explicit, authorized, confirmed user action can isolate the current node; cancellation, expired session, stale incident, or repeat submission cannot change state. KPIs and views reflect the same state. | Shared containment handler and pure transition | Transition tests before implementation; browser cancel/confirm/read-only/expired session/double submit. |
| INV-7: Panel follows selected node; no active incident means no Explain button. Checklist state belongs to incident ID; containment completion reflects actual state. | HUD state and panel | Browser node switch, healthy node, reopen, checklist, quarantine tests. |
| INV-8: Modal traps focus, closes with Escape, restores focus, works at 1280px and narrow widths. Skeleton appears only on the first open. | Native modal dialog plus scoped styles | Browser keyboard, close/reopen, 1280px and 390px screenshots. |
| INV-9: Markdown and print contain the same facts and current checklist state; clipboard failures are visible; print includes all content, without the dashboard. | Shared serializer; print CSS | Unit export tests; browser clipboard, print-media and PDF smoke test. |
| INV-10: HUD/brief runs without external network calls, keys, or LLM execution. | Local mock snapshot, local map geometry, offline layout mode | Browser rejects external requests and exercises flows; source/type/lint/build checks. |

## Decisions

- D-01: Add structured, timestamped telemetry to mock incidents; no generated evidence inside rules or React. Clearly mark the snapshot as mock data.
- D-02: Heartbeat loss alone is Unmapped: outages do not establish deliberate Service Stop. Canary access alone does not establish Credentials In Files; a matching credential file read is required.
- D-03: Use the current MITRE catalog verified on attack.mitre.org (2026-10-18); `/etc/shadow` maps to T1003.008. Agent impairment must follow the current canonical technique, not an assumed old ID.
- D-04: Use one shared confirmation for HUD and brief. Offline means unavailable; explicit `isolatedAt` records containment so heartbeat loss is never mistaken for a completed isolation.
- D-05: Persist analyst checklist state only in this page session, keyed by incident. No action other than the existing mock isolate transition executes anything.
- D-06: A healthy peer selection keeps the panel synchronized with a clear no-active-incident state; closing reveals that peer highlighted in the existing view.

## Phases

1. Data/rules boundary: schema, rule file, mock telemetry, mock inventory, engine, functional tests (six files). Write failing functional tests first.
2. Containment/UI boundary: transition + tests, HUD, panel, panel stylesheet, map integration (six files). Write failing containment tests first.
3. Offline/UAT boundary: minimal layout/network integration, test configuration and browser tests, verification report/screenshots. Run typecheck, lint, unit tests, production build, then browser verification.

## Threat model / ASVS L2 applicability

- No new server endpoint or persisted mutation. Browser role checks are a mock UX boundary, not a claim of production authorization. Preserve existing authentication; reject expired sessions at action time.
- Reject incident/node mismatches; scope peer inventory to the same tenant. Never import real secrets, credential contents, or API tokens into telemetry fixtures/exports.
- Bound strings and telemetry arrays; validate timestamps and canonical MITRE links; React text rendering and Markdown escaping prevent telemetry becoming executable content.
- No automatic network requests or LLM path. Clipboard and print require user clicks. Containment has explicit confirmation, permission checks, a stable incident target, and an idempotent transition.
- Backend authn/authz, rate limits, tenant queries and immutable audit persistence remain prerequisites for any future live implementation; no such integration is added here.

## Verification record

Pending implementation and UAT. Record actual results, not source-string checks or skipped imports.
