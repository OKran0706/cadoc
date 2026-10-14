---
plan: "27-01"
phase: 27
subsystem: "platform_service"
tags: ["fastapi", "sqlalchemy", "asyncpg", "postgres", "multitenancy", "redis", "liveness", "pagination"]
duration: "40min"
completed: "2026-05-17T22:30:00Z"
---

# Plan 27-01 Summary: Multi-Tenant Platform and Dashboard API

## What Was Built

Built a production-grade, highly secure, and optimized administrative Platform Service in FastAPI. The service acts as the central CMDB and telemetry control plane. It integrates dynamically with the monthly partitioned multi-tenant database using connection search path lease scoping, routes user requests via RBAC User JWTs containing tenant slugs, provisions new clients, brokers Sentinel join identity handshakes, and exposes cursor-paginated alerts engineered for partition pruning. It also integrates reactively with Redis keyspace expiration events to track Sentinel liveness without database polling.

Key deliverables:
- **FastAPI Platform Structure**: Configured full app modules under `src/platform_service/`.
- **Dynamic Connection search_path Routing**: Transactions dynamically lease connections and execute `SELECT public.set_tenant_search_path(:slug)` for scoping queries to isolated tenant schemas.
- **JWT & Hashing Security Engine**: Encodes administrative claims, checks user RBAC via tenant scopes, and safely signs/mints 15-minute Sentinel Join Tokens via HS256.
- **Client Provisioning API**: Interacts with the `public.provision_tenant` database migration to orchestrate complete schema and partitioned alert table setups.
- **Cursor Paginated Feed**: Encodes base64 next cursors and enforces direct boundary comparisons on `detected_at` to trigger PostgreSQL monthly partition pruning.
- **Reactive Liveness Event Watchdog**: Asynchronously subscribes to RedisKeyspace Expirations (`__keyevent@0__:expired`), captures offline Sentinel agent liveness notifications, and triggers atomic offline database state transitions.

## Key Files Created/Modified

| File | Action | Description |
|------|--------|-------------|
| `src/platform_service/requirements.txt` | Created | Declared production FastAPI, SQLAlchemy, asyncpg, passlib, PyJWT, and Redis dependencies. |
| `src/platform_service/Dockerfile` | Created | Multi-stage slim Docker image executing Uvicorn on port 8000. |
| `src/platform_service/app/core/config.py` | Created | Loads `CANARY_DB_CONN` and platform parameters via `pydantic-settings`. |
| `src/platform_service/app/core/database.py` | Created | Dynamic AsyncEngine pool and `set_tenant_search_path` session transaction scoping. |
| `src/platform_service/app/core/security.py` | Created | Passlib password verifications, RBAC login token decoders, and signed Join Token generators. |
| `src/platform_service/app/api/v1/endpoints/auth.py` | Created | `/login` endpoint authenticating users in `public.admin_users` and injecting tenant slug claims. |
| `src/platform_service/app/api/v1/endpoints/onboarding.py` | Created | `/provision` endpoint validating platform owner claims and executing DB onboarding routine. |
| `src/platform_service/app/api/v1/endpoints/bootstrap.py` | Created | Brokered `/join` endpoint verifying target server registered inside tenant schema and issuing join JWT. |
| `src/platform_service/app/api/v1/endpoints/dashboard.py` | Created | Partition-pruning cursor-paginated `/alerts` telemetry endpoint generating Base64 cursors. |
| `src/platform_service/app/services/liveness.py` | Created | Reactive Rediskeyspace expired subscription daemon and `mark_agent_offline` dynamic writer. |
| `src/platform_service/app/main.py` | Created | Assembles FastAPI routes, mounts CORS middleware, and spawns the background liveness lifespan task. |

## Commits

| Task | Hash | Description |
|------|------|-------------|
| T1 | `4c6c132` | feat(platform): T1 - initialize platform service setup and dependency specifications |
| T2 | `394fbe8` | feat(platform): T2 - configure settings using Pydantic Settings |
| T3 | `8faf702` | feat(platform): T3 - implement async SQLAlchemy dynamic tenant search path session routing |
| T4 | `fa271f1` | feat(platform): T4 - implement JWT validation, password hashing, and Join Token minting |
| T5 | `73be229` | feat(platform): T5 - build admin authentication and dynamic tenant onboarding endpoints |
| T6 | `f356033` | feat(platform): T6 - migrate brokered bootstrap join endpoint with tenant validation |
| T7 | `e57e3d9` | feat(platform): T7 - develop partition-pruned cursor-paginated alerts dashboard |
| T8 | `32e6132` | feat(platform): T8 - build reactive Redis Keyspace Expirations liveness listener |
| T9 | `f30ac45` | feat(platform): T9 - assemble FastAPI main application lifespans, API routing, and mount points |

## Notable Decisions

1. **Explicit Search Path Scoping**: Executing session `search_path` scoping (`set_tenant_search_path`) inside SQLAlchemy database transaction blocks is extremely fast, uses a single connection pool, and completely isolates tenant contexts safely.

2. **Base64 Composite Cursors**: Pagination utilizes a base64 encoded composite cursor of `(detected_at, id)`. This forces range constraints on the partition key `detected_at` during paging, allowing PostgreSQL to immediately prune unrelated partition tables and maintain lightning fast lookups.

3. **Background Lifespan Subscription**: Spawning the async Redis expired keyspace observer as an explicit FastAPI ASGI lifespan background task guarantees the daemon's lifecycle is exactly bound to the HTTP server process' lifetime.

4. **Public/Tenant Split RBAC**: Custom user authentication matches the `admin_users` global registration. JWT claims encode the user's tenant-scoped `company_slug`, allowing tenant admin users to access their own assets while preventing them from executing global `/provision` requests.

## Self-Check

| Check | Status |
|-------|--------|
| FastAPI platform service runs as a container and connects to CANARY_DB_CONN and REDIS_URL | ✅ |
| Dynamic tenant routing executes public.set_tenant_search_path(:slug) on leased DB connections dynamically | ✅ |
| Heartbeat expiration listener reacts to Redis keyspace __keyevent@0__:expired liveness events to flag agents offline | ✅ |
| Dashboard API exposes cursor-based pagination utilizing detected_at partition boundaries for tamper alerts | ✅ |
| All 9 tasks implemented and committed atomically | ✅ |

## Self-Check: PASSED
