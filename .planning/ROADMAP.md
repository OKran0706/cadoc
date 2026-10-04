# Roadmap: Canary Detection System

## Milestones

- ✅ **v1.3 Auditd Transition** — Phases 11-13 (shipped 2026-04-22)
- ✅ **v1.2 Unified Ingestion** — Phases 8-10 (shipped 2026-04-21)
- ✅ **v1.1 Sentinel Resilience** — Phases 5-7 (shipped 2026-04-21)
- ✅ **v1.0 Core Pipeline** — Phases 1-4 (shipped 2026-04-17)

## Phases

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

| Phase             | Milestone | Plans | Status   | Completed  |
| ----------------- | --------- | ----- | -------- | ---------- |
| 13. Auditd Pivot  | v1.3      | 4/4   | Complete | 2026-04-22 |
| 12. Container Ver | v1.3      | 1/1   | Complete | 2026-04-22 |
| 11. Native Auditd | v1.3      | 1/1   | Complete | 2026-04-22 |
| 10. E2E Flow      | v1.2      | 2/2   | Complete | 2026-04-21 |
| 9. mTLS Migration | v1.2      | 3/3   | Complete | 2026-04-21 |
| 8. Scaling Ingest | v1.2      | 3/3   | Complete | 2026-04-21 |
| 7. Ingestion Svc  | v1.1      | 3/3   | Complete | 2026-04-21 |
| 6. Hybrid Creds   | v1.1      | 3/3   | Complete | 2026-04-21 |
| 5. systemd Hard   | v1.1      | 4/4   | Complete | 2026-04-21 |

**Deferred:** Production-scale load testing acknowledged at v1.2 close.

## Backlog

- [ ] 999.1: Automated Canary Placement (Policy Engine)
- [ ] 999.2: Multi-Tenant Ingestion Isolation
- [ ] 999.3: Hardware-backed Key Storage (TPM 2.0 Integration)
