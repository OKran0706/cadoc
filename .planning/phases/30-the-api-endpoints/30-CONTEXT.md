# Phase 30: the api endpoints - Context

**Gathered:** 2026-05-21
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase delivers a complete set of user dashboard and node telemetry endpoints under the `/api/v1/dashboard/` namespace within the FastAPI Platform Service. It covers the following key capabilities:
1. **Summary KPIs**: Top-level dashboard cards (critical alert count, mitigated incident count, active analyst count, and network uptime).
2. **Node List / Inventory**: Fetching nodes merging static server data, database agent status, and live Redis heartbeat metrics.
3. **Risk Heatmap**: Virtual 2D grid mapping servers based on unmitigated alert density.
4. **Live Event Stream**: Server-Sent Events (SSE) stream subscribing to a tenant-specific Redis Pub/Sub channel.
5. **Deployment & Onboarding Check**: Generating one-time join tokens with dynamic install script commands, and verifying active registration.
6. **CSV Export**: Exporting telemetry metrics directly as a CSV download.

</domain>

<decisions>
## Implementation Decisions

### Route Names & Alignment
- **D-01:** Group all dashboard and node operations under the unified `/api/v1/dashboard/` routing prefix. 
  - `GET /api/v1/dashboard/summary`
  - `GET /api/v1/dashboard/nodes`
  - `GET /api/v1/dashboard/detections/heatmap`
  - `GET /api/v1/dashboard/alerts/stream`
  - `POST /api/v1/dashboard/alerts/{alert_id}/mitigate`
  - `POST /api/v1/dashboard/servers/token`
  - `POST /api/v1/dashboard/servers/verify`
  - `GET /api/v1/dashboard/reports/export`

### Mitigation Lifecycle (Auditing & Compliance)
- **D-02:** Track manual analyst mitigations in a tenant-isolated database table `client_{company_slug}.alert_mitigations` rather than modifying `tamper_alerts` directly (since they are strictly read-only and immutable for compliance).
- **D-03:** Mitigations are strictly append-only. There is no `DELETE` or unmitigate endpoint to ensure a permanent forensic audit trail.

### Uptime & Heartbeat Resiliency
- **D-04:** Calculate network uptime as `(active_agents / total_agents) * 100`.
- **D-05:** **Special Zero-Agent Rule:** If 0 agents are registered, network uptime must return `"N/A"`.
- **D-06:** When an agent goes offline (Redis liveness TTL expires), its static database metadata (version, git commit, status) is preserved, but real-time telemetry metrics (CPU, Memory, Disk) must return `null`.

### Virtual 2D Grid for Heatmap
- **D-07:** Deterministically map registered servers to a virtual 2D grid `(row, col)`. Group servers by geographic location or project code sequentially to cluster related nodes together.
- **D-08:** Grid dimensions are calculated dynamically as the smallest square grid fitting all nodes (e.g. 4x4 for up to 16 servers, 8x8 for up to 64 servers).

### Live Event Stream (SSE)
- **D-09:** The event stream subscribes to a Redis Pub/Sub channel named `tenant:{company_slug}:alerts` to deliver new security alerts with sub-millisecond latency. Strict multi-tenant authorization filters alerts by the user's authenticated `company_slug`.

### Add Server & Verification
- **D-10:** `POST /api/v1/dashboard/servers/token` routes user-login JWT credentials to generate a brokered one-time join token via the existing `bootstrap.py` logic, and outputs a dynamic curl installation shell script.
- **D-11:** `POST /api/v1/dashboard/servers/verify` checks if a server has registered successfully as `active` in the DB or has a live Redis heartbeat.

### the agent's Discretion
- Choice of standard FastAPI logging, CSV layout format, and precise grid coordinate formulas is at the agent's discretion.

</decisions>

<specifics>
## Specific Ideas

- **CSV Export Format**: Export columns should contain: Node ID, Hostname, IP Address, Location, Registered Status, CPU, Memory, Critical Alerts, Mitigated Incidents.
- **Dynamic Install Command**: The generated response for `/servers/token` should look like:
  ```json
  {
    "token": "signed-jti-token",
    "expires_at": "timestamp",
    "install_command": "curl -sSL https://cadoc.io/install.sh | bash -s -- --token signed-jti-token"
  }
  ```

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Multi-Tenant Database & RBAC
- [001_multi_tenant_onboarding.sql](file:///c:/Users/Karan/Desktop/canary/cadoc/database/migrations/001_multi_tenant_onboarding.sql) — Defines dynamic connections and schemas.
- [002_admin_rbac.sql](file:///c:/Users/Karan/Desktop/canary/cadoc/database/migrations/002_admin_rbac.sql) — RBAC definitions.
- [27-CONTEXT.md](file:///c:/Users/Karan/Desktop/canary/cadoc/.planning/phases/27-multi-tenant-platform-and-dashboard-api/27-CONTEXT.md) — Base connection routing strategy.
- [29-CONTEXT.md](file:///c:/Users/Karan/Desktop/canary/cadoc/.planning/phases/29-create-administrative-control-plane/29-CONTEXT.md) — Administrative RBAC enforcement decisions.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `verify_user_jwt` ([security.py](file:///c:/Users/Karan/Desktop/canary/cadoc/src/platform_service/app/core/security.py#L17)): For user authorization context.
- `set_tenant_search_path` ([database.py](file:///c:/Users/Karan/Desktop/canary/cadoc/src/platform_service/app/core/database.py)): Dynamic schema routing helper.

### Established Patterns
- All operations are isolated at the schema level by running `SELECT public.set_tenant_search_path('client_{slug}')`.

</code_context>

<deferred>
## Deferred Ideas

- None — discussion stayed entirely within the backend dashboard API domain.

</deferred>

---

*Phase: 30-the-api-endpoints*
*Context gathered: 2026-05-21*
