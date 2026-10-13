# Phase 27: Multi-Tenant Platform and Dashboard API - Context

**Gathered:** 2026-05-17
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase delivers a production-ready FastAPI platform service behind an Nginx reverse proxy. It serves as our central administrative control plane (CMDB), handling user login, dynamic client onboarding via isolated database schemas, user authentication and RBAC validation, brokered Sentinel join token generation, high-performance telemetry query endpoints (using partition-optimized cursor pagination), and reactive agent liveness tracking via Redis TTL keyspace expirations.

</domain>

<decisions>
## Implementation Decisions

### Dynamic Schema Routing Strategy
- **D-01**: A single asynchronous SQLAlchemy connection pool is used for the database engine. Every API request targeting a client-specific resource passes through a FastAPI dependency that extracts the client slug, leases a connection from the pool, and executes `SELECT public.set_tenant_search_path(:slug)` for the session transaction before running standard queries.

### Brokered Identity & JWT RBAC Validation
- **D-02**: The `/bootstrap/join` endpoint is migrated from the Ingestion Service to this new Platform Service. The endpoint requires user-login JWT authentication. The JWT payload embeds the `company_slug` (tenant slug) claim. The FastAPI endpoint validates the user's role scope, switches the transaction search path to the target tenant, and mints the signed one-time-use Sentinel Join Token.

### Telemetry Dashboard & Partition-Aware Querying
- **D-03**: All high-volume telemetry queries (such as alerts and audits) on partitioned tables leverage **cursor-based pagination** using `(detected_at, id)` as the cursor keys. Enforcing strict cursor constraints on the range-partitioned column `detected_at` enables PostgreSQL's query planner to perform instant **partition pruning**, ensuring sub-millisecond query execution regardless of database size.

### Sentinel Agent Liveness Resolution (Heartbeats)
- **D-04**: Sentinels ship heartbeats directly to the Ingestion Service via secured mTLS. The Ingestion Service parses these heartbeats and records the liveness state in Redis under `agent:heartbeat:{agent_id}` with a 120-second TTL on behalf of the agent. The Platform Service runs a reactive, lightweight background listener subscribing to Redis Keyspace Notifications (`__keyevent@0__:expired`). When an agent's heartbeat TTL expires, the listener receives the event and executes an async write to update that Sentinel's database status to `offline`, completely eliminating periodic SQL polling overhead.

### the agent's Discretion
- Choice of standard FastAPI logging, CORS, and request middleware setups is deferred to the agent.
- Standard hashing library (e.g. `passlib` with `bcrypt` or standard `argon2`) for user credentials is at the agent's discretion.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Multi-Tenant Database Schema
- [001_multi_tenant_onboarding.sql](file:///c:/Users/Karan/Desktop/canary/cadoc/database/migrations/001_multi_tenant_onboarding.sql) — Defines the tenant onboarding PL/pgSQL routines, dynamic schema creation, search path resolution, and range partitioned table schemas.
- [context_database_onboarding.md](file:///C:/Users/Karan/.gemini/antigravity/brain/8d089f64-6a73-474c-9e09-2d4e87e4387d/context_database_onboarding.md) — Unified database control plane specification and immutable alert triggers.

### Brokered Bootstrap Reference
- [bootstrap.py](file:///c:/Users/Karan/Desktop/canary/cadoc/src/ingestion_service/bootstrap.py) — Defines the signed one-time-use Join Token minting, Redis JTI blacklisting, and validation logic that is being migrated.
- [main.py](file:///c:/Users/Karan/Desktop/canary/cadoc/src/ingestion_service/main.py#L161-L208) — Ingestion Service bootstrap route definitions.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `verify_user_jwt` & `mint_join_token` ([bootstrap.py](file:///c:/Users/Karan/Desktop/canary/cadoc/src/ingestion_service/bootstrap.py#L64-L81)): JWT decoding, verification, and HS256 minting logic should be reused in `app/core/security.py`.
- `get_redis_client` ([bootstrap.py](file:///c:/Users/Karan/Desktop/canary/cadoc/src/ingestion_service/bootstrap.py#L102-L105)): Redis connection factory for one-time token blacklisting and keyspace liveness monitoring.

### Established Patterns
- Isolated tenant search paths are established by running `SELECT public.set_tenant_search_path('client_{slug}')`.
- One-time join token state is tracked via Redis JTI blacklisting with active TTL.

### Integration Points
- **Nginx Reverse Proxy**: Connects downstream clients to the platform API gateway `/api/v1/` and routes event streams `/bootstrap/join`.
- **Telemetry Ingestion Pipeline**: Telemetry consumption continues asynchronously, while the platform service reads from the partitioned tables written by downstream consumers.

</code_context>

<specifics>
## Specific Ideas
- The platform service user JWT must embed the `company_slug` claim to make schema mapping direct, secure, and fast.
- Cursor pagination response payload format:
  ```json
  {
    "data": [...],
    "paging": {
      "next_cursor": "base64_string_containing_timestamp_and_id",
      "has_more": true
    }
  }
  ```

</specifics>

<deferred>
## Deferred Ideas

### Pending Roadmap Items
- 999.1: Automated Canary Placement (Policy Engine)
- 999.2: Multi-Tenant Ingestion Isolation (isolating ingest-level database writers)
- 999.3: Hardware-backed Key Storage (TPM 2.0 Integration)

</deferred>

---

*Phase: 27-Multi-Tenant Platform and Dashboard API*
*Context gathered: 2026-05-17*
