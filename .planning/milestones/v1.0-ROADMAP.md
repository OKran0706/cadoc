# Roadmap: Canary Detection System

## Milestone: v1.0 — Core Pipeline & Onboarding

### Phase 1: Secure Onboarding API
**Goal:** Build the API that accepts a `server_id`, mints a scoped HashiCorp Vault token, and returns a drop-in deployment command.
- **Focus**: Vault API integration, endpoint routing, and script wrapping.
- **Dependencies**: None.

### Phase 2: Core Pipeline Hardening (Zero-Disk)
**Goal:** Audit the existing Sentinel A, Kafka, and Detection Engine interactions to enforce the strict zero-disk policy.
- **Focus**: Replacing legacy file-based cert usage with the `sysutil` internal package.
- **Dependencies**: Phase 1.

### Phase 3: Fail-Closed Resiliency
**Goal:** Fortify the fail-closed mechanism to differentiate network drops from tampering.
- **Focus**: eBPF interaction audits, connection timeout behaviors, and reliable heartbeat metrics.
- **Dependencies**: Phase 2.
