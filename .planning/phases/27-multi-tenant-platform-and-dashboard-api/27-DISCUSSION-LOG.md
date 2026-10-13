# Phase 27: Multi-Tenant Platform and Dashboard API - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-17
**Phase:** 27-Multi-Tenant Platform and Dashboard API
**Areas discussed:** Schema Routing Strategy, Brokered Identity & JWT RBAC, Partition Telemetry Pagination, Agent Liveness Resolution

---

## Schema Routing Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Option 1 | Single asynchronous SQLAlchemy connection pool. FastAPI dependency leases a connection and executes `SELECT public.set_tenant_search_path(:slug)` for the session transaction before running standard queries. | ✓ |
| Option 2 | Separate engine pool per tenant. Cache and manage multiple engine instances dynamically. | |

**User's choice:** Option 1
**Notes:** Provides a highly dynamic, lightweight database mapping. Schema-level scoping is achieved with minimal connection management overhead.

---

## Brokered Identity & JWT RBAC

| Option | Description | Selected |
|--------|-------------|----------|
| Option 1 | User JWT token contains the company slug, validated to confirm RBAC roles and authorize join token generation. | ✓ |
| Option 2 | Query schema-isolated tables directly to assert authorization context dynamically. | |

**User's choice:** Option 1 (JWT-brokered RBAC validation)
**Notes:** User verified JWT claims (including company slug) are used directly to validate permissions before switching search path and performing token retrieval.

---

## Partition Telemetry Pagination

| Option | Description | Selected |
|--------|-------------|----------|
| Option 1 | Enforce cursor-based pagination using `(detected_at, id)` as cursor keys, leveraging partition pruning. | ✓ |
| Option 2 | Standard OFFSET / LIMIT pagination. | |

**User's choice:** Option 1 (Cursor-based pagination)
**Notes:** Essential for massive database scaling. Avoids high-latency sequential scans on monthly partitions by utilizing the range-partitioned column as a cursor filtering parameter.

---

## Agent Liveness Resolution

| Option | Description | Selected |
|--------|-------------|----------|
| Option 1 | Redis TTL Expiration Listener. Subscribe to Keyspace expired notifications (`__keyevent@0__:expired`) and update database status. | ✓ |
| Option 2 | Periodic database scanning worker polling `sentinel_agents.last_heartbeat`. | |

**User's choice:** Option 1 (Keyspace notifications)
**Notes:** Incredibly elegant and reactive. Minimizes database traffic by letting Redis manage timeouts, reacting only when heartbeats are missed.

---

## the agent's Discretion
- Choice of standard FastAPI logging, CORS, and request middleware setups is deferred to the agent.
- Choice of JWT encryption secret storage and token lifecycle length.

## Deferred Ideas
- None — all discussed concepts aligned directly with the Phase 27 administrative CMDB boundary.
