# Phase 33: Flow Testing and Missing APIs for Platform Service - Context

**Gathered:** 2026-06-11
**Status:** Ready for planning
**Source:** User Discussion

<domain>
## Phase Boundary
Implement missing resource management APIs (Projects, Servers, Agent Listing) and design comprehensive E2E flow tests for the Platform Service.
</domain>

<decisions>
## Implementation Decisions

### 1. Flow Testing Strategy
- **Pytest Suite**: Create a comprehensive automated pytest suite (`src/platform_service/tests/test_e2e_flows.py`) utilizing `pytest-asyncio` and `httpx.AsyncClient` that exercises complete onboarding, token-issuing, and resource management flows.
- **Staging Verification Script**: Create a live Python verification script (`test-env/verify-platform-flows.py`) that executes against the live Platform Service instance inside the Vagrant VM, validating actual HTTP requests and response structures.
- **Scope Restriction**: Both the automated tests and live script will focus strictly on testing **Platform Service APIs** (not the native Sentinel daemon event loop or Kafka directly).

### 2. Missing Resource Management APIs
To enable realistic onboarding and flow testing:
- **Projects Router (`/api/v1/projects`)**:
  - `POST /`: Create a project. Requires `project.manage` permission.
  - `GET /`: List projects. Requires `project.read` permission.
- **Servers Router (`/api/v1/servers`)**:
  - `POST /`: Register a server under a project. Requires `server.manage` permission.
  - `GET /`: List servers. Requires `server.read` permission.
- **Agents Router Expansion (`/api/v1/agents`)**:
  - `GET /`: List all sentinel agents for the current tenant. Requires `security.read` permission.

### 3. Tenant Isolation
- **404 Not Found for Isolation Violations**: Because requests are schema-routed using the user's `company_slug` claim, querying/modifying a resource belonging to Tenant B from Tenant A's context must return a `404 Not Found` response (since it won't exist in Tenant A's partitioned tables).
- **Global vs. Tenant Auth**: E2E flows must verify that global admin credentials allow listing across all clients, whereas tenant credentials/keys are strictly bound to their respective schemas.
</decisions>

<canonical_refs>
## Canonical References
- `src/platform_service/app/main.py`
- `src/platform_service/app/api/v1/endpoints/agents.py`
- `src/platform_service/app/api/v1/endpoints/onboarding.py`
- `src/platform_service/app/core/security.py`
- `database/migrations/001_multi_tenant_onboarding.sql`
</canonical_refs>

<specifics>
## Specific Ideas
- The E2E tests should dynamically generate random slug/tenant identifiers to prevent state collision between runs.
</specifics>

<deferred>
## Deferred Ideas
- Testing of dynamic background certificate renewal logic (PKI-02) is deferred to a future phase.
</deferred>
