# Roadmap: Canary Detection System

## Milestones

- ✅ **v1.0 Core Pipeline & Onboarding** — Phases 1-3 (shipped 2026-04-17) [Archive](milestones/v1.0-ROADMAP.md)
- ✅ **v1.1 Sentinel Resilience & Auto-Restart Flow** — Phases 4-6 (shipped 2026-04-21) [Archive](milestones/v1.1-ROADMAP.md)
- ✅ **v1.2 Integrated Test Environment** — Phase 7 (shipped 2026-04-21) [Archive](milestones/v1.2-ROADMAP.md)
- 🚧 **v1.3 Zero-Dependency Monitoring** — Phases 11-12 (target 2026-04-25)

## Phases

<details>
<summary>✅ v1.0 Core Pipeline & Onboarding (Phases 1-3) — SHIPPED 2026-04-17</summary>

- [x] Phase 1: Secure Onboarding API (1 plan) — completed 2026-04-17
- [x] Phase 2: Core Pipeline Hardening (1 plan) — completed 2026-04-17
- [x] Phase 3: Fail-Closed Resiliency (0 plans) — completed 2026-04-17

</details>

<details>
<summary>✅ v1.1 Sentinel Resilience & Auto-Restart Flow (Phases 4-6) — SHIPPED 2026-04-21</summary>

- [x] Phase 4: Service Daemonization (1 plan) — completed 2026-04-17
- [x] Phase 5: Hybrid Credential Persistence (1 plan) — completed 2026-04-21
- [x] Phase 6: Resilient Vault Polling (1 plan) — completed 2026-04-21

</details>

<details>
<summary>✅ v1.2 Integrated Test Environment (Phase 7) — SHIPPED 2026-04-21</summary>

- [x] Phase 7: Backend Ingestion & Liveness Service (3/3 plans) — completed 2026-04-21

</details>

### v1.3 Native Auditd Monitoring

- [x] Phase 11: Native Auditd Integration (libaudit)
- [ ] Phase 12: Functional Container Verification
- [ ] Phase 13: Remove eBPF Dependency (Transition to Auditd)

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1-3   | v1.0      | 2/2            | Shipped | 2026-04-17 |
| 4-6   | v1.1      | 3/3            | Shipped | 2026-04-21 |
| 7     | v1.2      | 3/3            | Shipped | 2026-04-21 |
| 11    | v1.3      | 0/1            | Planned | - |
| 12    | v1.3      | 0/2            | Planned | - |
| 13    | v1.3      | 0/1            | Planned | - |

**Deferred:** Production-scale load testing acknowledged at v1.2 close.
