# Phase 33: Flow Testing and Missing APIs for Platform Service - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-11
**Phase:** 33-flow-testing-and-missing-apis-for-platform-service
**Areas discussed:** Flow Testing Strategy, Missing Resource Management APIs, Tenant Isolation

---

## Flow Testing Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Option 1: Both | Automated pytest integration flow tests AND a live staging validation script | ✓ |
| Option 2: Automated Pytest Only | Verify flows using mocked/isolated database integrations inside the python test suite | |
| Option 3: Live Staging Only | Verify flows directly against the live Vagrant staging environment | |

**User's choice:** Option 1 (Both).
**Notes:** The testing harness will cover both automated integration tests (using pytest and httpx.AsyncClient) and a live staging script (`test-env/verify-platform-flows.py`) running inside the Vagrant VM, but focusing strictly on the Platform Service APIs.

---

## Missing Resource Management APIs

| Option | Description | Selected |
|--------|-------------|----------|
| Option A: Do Not Implement | Use manual SQL seeds to populate server/project data in tests | |
| Option B: Implement Needed REST Endpoints | Implement `/projects`, `/servers`, and list agents `/agents` APIs in Platform Service | ✓ |

**User's choice:** Option B (Implement Needed REST Endpoints).
**Notes:** Implement Project creation/listing, Server registration/listing, and Sentinel Agent listing in the codebase under their respective routers.

---

## Tenant Isolation

| Option | Description | Selected |
|--------|-------------|----------|
| Option A: 403 Forbidden | Return 403 Forbidden when accessing resources of other tenants | |
| Option B: 404 Not Found | Return 404 Not Found as the resource does not exist in the tenant's schema search path | ✓ |

**User's choice:** Option B (404 Not Found).
**Notes:** For tenant isolation, return 404 Not Found when a tenant attempts to query a resource belonging to another tenant, aligning with schema-level partitioning where the resource is genuinely absent from their namespace.

---

## the agent's Discretion
- Concrete path schemas and request/response models for `/projects` and `/servers` routers.
- The choice of random slug/tenant naming format in the test harness to guarantee isolation.

## Deferred Ideas
- None — discussion stayed entirely within the backend control plane boundary.

---

*Phase: 33-flow-testing-and-missing-apis-for-platform-service*
*Discussion log generated: 2026-06-11*
