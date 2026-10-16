# Roadmap: Canary Detection System

## Milestones

- ⬜ **v1.6 Trusted Identity & Orchestration** — Phases 22-24 (target: 2026-05-30)
- ✅ **v1.5 Code Quality & Reliability** — Phases 19-21 (shipped 2026-05-08) — [Archive](file:///.planning/milestones/v1.5-ROADMAP.md)
- ✅ **v1.4 Sentinel Hardening** — Phases 14-18 (shipped 2026-05-08) — [Archive](file:///.planning/milestones/v1.5-ROADMAP.md)

## Phases

<details open>
<summary>⬜ v1.6 Trusted Identity & Orchestration (Phases 22-24)</summary>

- [ ] **Phase 22: Secure Identity Bootstrapping**
  - Goal: Implement the brokered AppRole handshake and log redaction.
  - Requirements: AUTH-01, AUTH-02, AUTH-03, AUTH-04, OPS-01, OPS-02
  - Success Criteria:
    - Sentinel logs in to Vault using a SecretID brokered by the Ingestion API.
    - Sensitive headers and tokens are redacted from all Sentinel logs.
    - Deployment script supports one-time join tokens.

- [ ] **Phase 23: Dynamic PKI Integration**
- [ ] **Phase 24: Operational Resilience (Lease Management)**
- [ ] **Phase 25: Vault-less Sentinel Architecture (Brokered Secrets)**
  - Goal: Remove direct Sentinel-to-Vault communication; proxy all secrets via Ingestion Service.

</details>
- ✅ **v1.3 Auditd Transition** — Phases 11-13 (shipped 2026-04-22)
- ✅ **v1.2 Unified Ingestion** — Phases 8-10 (shipped 2026-04-21)
- ✅ **v1.1 Sentinel Resilience** — Phases 5-7 (shipped 2026-04-21)
- ✅ **v1.0 Core Pipeline** — Phases 1-4 (shipped 2026-04-17)


- [ ] **Phase 14: Boot & Lifecycle Foundation**
  - Goal: Fix subcommand parsing and implement robust HTTP/PID management.
  - Requirements: BOOT-01, BOOT-02, BOOT-05
  - Success Criteria:
    - `audit-consume` works regardless of flag order.
    - Sentinel reuses HTTP connections via pooled client.
    - PID file directory is created safely and liveness is checked.

- [ ] **Phase 15: Structured Error & Ingestion Hardening**
  - Goal: Eliminate ignored errors and implement structured Vault/HTTP handling.
  - Requirements: ERR-01, ERR-02, ERR-03, ERR-04
  - Success Criteria:
    - Zero `_` error ignores in core event loops.
    - Vault 403/404 handled via typed errors.
    - Ingestion check fails on 5xx and supports `/health`.

- [ ] **Phase 16: Security, Privileges & Kill Switch**
  - Goal: Audit capability drop order and harden the killswitch verifier.
  - Requirements: SEC-01, SEC-02, SEC-03, SEC-04
  - Success Criteria:
    - `systemctl` calls completed before root privileges are dropped.
    - Nil verifier check added to killswitch poller.
    - Invalid tickets trigger OOB alerts.

- [ ] **Phase 17: Graceful Shutdown & Goroutine Cleanup**
  - Goal: Implement clean shutdown signal handling and leak prevention.
  - Requirements: BOOT-03, BOOT-04, RES-01, RES-02
  - Success Criteria:
    - Sentinel exits without `os.Exit` in goroutines.
    - `wg.Wait()` ensures all heartbeats are flushed before exit.
    - Audit socket shuts down within 10s timeout.

- [x] **Phase 18: Production Readiness Verification**
  - Goal: Test if Sentinel is ready for production.
  - Requirements: TBD
  - Success Criteria:
    - E2E tests pass in production-like environment.
    - Performance metrics meet production standards.
    - No critical vulnerabilities found in production audit.


</details>

<details>
<summary>✅ v1.3 Auditd Transition (Phases 11-13) — SHIPPED 2026-04-22</summary>

- [x] Phase 11: Native Auditd Integration (libaudit)
- [x] Phase 12: Functional Container Verification
- [x] Phase 13: Remove eBPF Dependency (Transition to Auditd)

</details>

<details>
<summary>✅ v1.2 Unified Ingestion (Phases 8-10) — SHIPPED 2026-04-21</summary>

- [x] Phase 8: Scaling Ingestion Service
- [x] Phase 9: Sentinel-A mTLS Migration
- [x] Phase 10: Integrated E2E Telemetry Flow

</details>

<details>
<summary>✅ v1.1 Sentinel Resilience (Phases 5-7) — SHIPPED 2026-04-21</summary>

- [x] Phase 5: systemd Integration & Hardening
- [x] Phase 6: Hybrid Credential Model
- [x] Phase 7: Backend Ingestion Service

</details>

<details>
<summary>✅ v1.0 Core Pipeline (Phases 1-4) — SHIPPED 2026-04-17</summary>

- [x] Phase 1: Foundation (Core Pipeline)
- [x] Phase 2: Signer (Ed25519 Implementation)
- [x] Phase 3: Vault Integration (Secret Management)
- [x] Phase 4: Kafka Event Bus (Ingestion)

</details>

## Progress

| Phase                    | Milestone | Plans | Status   | Completed  |
| ------------------------ | --------- | ----- | -------- | ---------- |
| 25. Vault-less Arch      | v1.6      | 0/1   | Pending  | -          |
| 22. Identity Bootstrap   | v1.6      | 1/1   | Complete | 2026-05-16 |
| 21. Hardening & Defence  | v1.5      | 2/2   | Complete | 2026-05-08 |
| 20. Operational Reliab.  | v1.5      | 4/4   | Complete | 2026-05-08 |
| 19. Critical Safety      | v1.5      | 2/2   | Complete | 2026-05-08 |
| 18. Prod Ready           | v1.4      | 1/1   | Complete | 2026-04-26 |
| 17. Graceful Exit        | v1.4      | 0/1   | Pending  | -          |
| 16. Sec & Kill           | v1.4      | 0/1   | Pending  | -          |
| 15. Err Hardening        | v1.4      | 0/1   | Pending  | -          |
| 14. Boot Foundat         | v1.4      | 0/1   | Pending  | -          |
| 13. Auditd Pivot         | v1.3      | 4/4   | Complete | 2026-04-22 |
| ...                      | ...       | ...   | ...      | ...        |

## Backlog

- [ ] 999.1: Automated Canary Placement (Policy Engine)
- [ ] 999.2: Multi-Tenant Ingestion Isolation
- [ ] 999.3: Hardware-backed Key Storage (TPM 2.0 Integration)

### Phase 26: Deploy multi-node staging environment with 2 Vagrant VMs

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 25
**Plans:** 1/1 plans complete

Plans:
- [x] TBD (run /gsd-plan-phase 26 to break down) (completed 2026-05-17)

### Phase 27: Multi-Tenant Platform and Dashboard API

**Goal:** Implement administrative control plane with dynamic DB schema search path routing, brokered bootstrap JWT validation, Redis keyspace liveness tracking, and cursor paginated alerts.
**Requirements**: TBD
**Depends on:** Phase 26
**Plans:** 1/1 plans complete

Plans:
- [x] 27-01: Multi-Tenant Platform and Dashboard API (completed 2026-05-17)

### Phase 28: Fetch system metrics in heartbeat

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 27
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 28 to break down)

### Phase 29: Create administrative control plane

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 28
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 29 to break down)

### Phase 30: the api endpoints

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 29
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 30 to break down)

### Phase 31: Implement multi-tenant auth updates (consolidate public/tenant schemas)

**Goal:** Consolidate platform auth tables into global admins and tenant-isolated users/roles/keys.
**Requirements**: TBD
**Depends on:** Phase 30
**Plans:** 1/1 plans complete

Plans:
- [x] 31-01: Federated Multi-Tenant Auth Schema Consolidation (completed 2026-06-11)

### Phase 32: fixing broken apis

**Goal:** Refactor and fix broken API endpoints and align tests with consolidated multi-tenant schemas.
**Requirements**: TBD
**Depends on:** Phase 31
**Plans:** 1/1 plans complete

Plans:
- [x] 32-01: Refactoring Broken APIs for Consolidated Auth Schema (completed 2026-06-11)

### Phase 33: Flow Testing and Missing APIs for Platform Service

**Goal:** Implement missing Projects, Servers, and Agent Listing APIs in the Platform Service, and create automated pytest flow tests and a live staging verification script to test E2E platform flows and schema-isolated tenant security.
**Requirements**: TBD
**Depends on:** Phase 32
**Plans:** 1 plan

Plans:
- [ ] 33-01: Flow Testing and Missing APIs for Platform Service
