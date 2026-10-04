# Milestone History

## v1.3 — Auditd Transition
**Shipped:** 2026-04-22
**Summary:** Transitioned from eBPF/Tetragon to native Auditd monitoring.
**Key Accomplishments:**
- Implemented native Auditd record reassembly and IPC worker.
- Established live, memory-only rule injection via `AuditctlManager`.
- Implemented resilient IPC with exponential backoff and subsystem health monitoring.
- Achieved Zero-Dependency and Low-Privilege Sentinel operation.
**Archived:** [.planning/milestones/v1.3-phases/](file:///c:/Users/Karan/Desktop/canary/cadoc/.planning/milestones/v1.3-phases/)

## v1.2 Integrated Test Environment (Shipped: 2026-04-21)

**Phases completed:** 1 phase (7), 3 plans

**Key accomplishments:**
- Unified FastAPI ingestion service with non-blocking Kafka routing
- Sentinel-A migrated from direct Kafka to mTLS HTTP transport
- Redis liveness tracking with 90-second TTL
- NGINX load-balanced horizontal scaling (2+ replicas)
- End-to-end telemetry pipeline verified

**Known deferrals:** Phase 11 (Failure Injection) - 1 todo acknowledged and deferred to v1.3

---

## 1.1 Sentinel Resilience & Auto-Restart Flow (Shipped: 2026-04-17)

**Phases completed:** 3 phases, 3 plans, 0 tasks

**Key accomplishments:**

- (none recorded)

---

## v1.0 Core Pipeline & Onboarding (Shipped: 2026-04-17)

**Phases completed:** 2 phases, 2 plans, 0 tasks

**Key accomplishments:**

- (none recorded)

---
