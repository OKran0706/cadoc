# Roadmap: Canary Detection System

## Milestones

- ✅ **v1.0 Core Pipeline & Onboarding** — Phases 1-3 (shipped 2026-04-17)
- 🚧 **v1.1 Sentinel Resilience & Auto-Restart Flow** — Phases 4-6 (in progress)

## Phases

<details>
<summary>✅ v1.0 Core Pipeline & Onboarding (Phases 1-3) — SHIPPED 2026-04-17</summary>

- [x] Phase 1: Secure Onboarding API (1 plan) — completed 2026-04-17
- [x] Phase 2: Core Pipeline Hardening (1 plan) — completed 2026-04-17
- [x] Phase 3: Fail-Closed Resiliency (0 plans) — completed 2026-04-17

</details>

## Milestone: v1.1 — Sentinel Resilience & Auto-Restart Flow (In Progress)

### Phase 4: Service Daemonization
**Goal:** Wrap Sentinel in a robust systemd service that enforces file sandboxing.
**Requirements:** SRV-01, SRV-02
- [ ] **4-01**: Service unit testing

### Phase 5: Hybrid Credential Persistence
**Goal:** Implement fallback auto-reauthentication using persistent public certs while keeping private keys zero-disk.
**Requirements:** AUTH-01, AUTH-02, AUTH-03
- [ ] **5-01**: Credential persistence logic

### Phase 6: Resilient Vault Polling
**Goal:** Implement exponential backoff for manual downtime blocks from Vault.
**Requirements:** VAULT-01, VAULT-02, VAULT-03
- [ ] **6-01**: Backoff fetch logic

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Secure Onboarding API | v1.0 | 1/1 | Complete | 2026-04-17 |
| 2. Core Pipeline Hardening | v1.0 | 1/1 | Complete | 2026-04-17 |
| 3. Fail-Closed Resiliency | v1.0 | 0/0 | Complete | 2026-04-17 |
| 4. Service Daemonization | v1.1 | 0/1 | Not started | - |
| 5. Hybrid Credential Persistence | v1.1 | 0/1 | Not started | - |
| 6. Resilient Vault Polling | v1.1 | 0/1 | Not started | - |

