# Phase 33 Research: Flow Testing and Missing APIs for Platform Service

## 1. Missing Resource Management APIs
To allow E2E flow testing, we must implement missing routers and endpoints in the Platform Service:

### A. Projects Router (`src/platform_service/app/api/v1/endpoints/projects.py`)
- **Table**: `client_{company_slug}.projects`
- **Fields**: `id`, `name`, `description`, `created_at`, `updated_at`
- **Routes**:
  - `POST /api/v1/projects`: Creates a new project. Request body: `name: str`, `description: Optional[str]`. Permission: `project.manage`.
  - `GET /api/v1/projects`: Lists all projects. Permission: `project.read`.

### B. Servers Router (`src/platform_service/app/api/v1/endpoints/servers.py`)
- **Table**: `client_{company_slug}.servers`
- **Fields**: `id`, `project_id`, `hostname`, `ip_address`, `status`, `specs`, `created_at`, `updated_at`
- **Routes**:
  - `POST /api/v1/servers`: Registers a server. Request body: `project_id: UUID`, `hostname: str`, `ip_address: str`, `status: str = 'online'`, `specs: Optional[dict] = {}`. Permission: `server.manage`.
  - `GET /api/v1/servers`: Lists all servers. Permission: `server.read`.

### C. Agents Router Expansion (`src/platform_service/app/api/v1/endpoints/agents.py`)
- **Table**: `client_{company_slug}.sentinel_agents`
- **Routes**:
  - `GET /api/v1/agents`: Lists all agents for the tenant. Permission: `security.read`.

---

## 2. API Registration in `main.py`
Add the new routers to `src/platform_service/app/main.py`:
- `app.include_router(projects.router, prefix="/api/v1/projects", tags=["projects"])`
- `app.include_router(servers.router, prefix="/api/v1/servers", tags=["servers"])`

---

## 3. Flow Verification Strategy

### A. Automated Integration Tests (`src/platform_service/tests/test_e2e_flows.py`)
Using `pytest` and `httpx.AsyncClient` with transaction rollback:
1. **Onboarding & Setup Flow**:
   - Provision a new tenant schema dynamically using `POST /api/v1/onboarding/provision` (global admin JWT).
   - Create a project via `POST /api/v1/projects`.
   - Register a server under the project via `POST /api/v1/servers`.
   - Request a Sentinel Join Token via `POST /api/v1/bootstrap/join` targeting the registered server ID.
2. **Tenant Isolation Flow**:
   - Authenticate as two different tenants (Tenant A and Tenant B).
   - Attempt to access/modify Tenant B's server or project using Tenant A's credentials and assert a `404 Not Found` response.

### B. Live Staging Script (`test-env/verify-platform-flows.py`)
A standalone Python script executing on the host or server VM:
- Authenticates using a generated JWT token.
- Calls `POST /api/v1/onboarding/provision` to provision a test tenant slug.
- Calls the projects, servers, and agents endpoints to verify schema-qualified queries work on the live PostgreSQL DB.
- Attempts cross-tenant requests and asserts `404 Not Found`.

---

## 4. Validation Architecture
- **Automated Tests**:
  - Command: `.\venv\Scripts\pytest src/platform_service/tests/test_e2e_flows.py`
- **Manual Verification**:
  - Command: `vagrant ssh server -c "python3 /vagrant/test-env/verify-platform-flows.py"`
