---
plan: "33-01"
phase: 33
type: "standard"
wave: 1
depends_on: []
files_modified:
  - "src/platform_service/app/main.py"
  - "src/platform_service/app/api/v1/endpoints/agents.py"
  - "src/platform_service/app/api/v1/endpoints/projects.py"
  - "src/platform_service/app/api/v1/endpoints/servers.py"
  - "src/platform_service/tests/test_e2e_flows.py"
  - "test-env/verify-platform-flows.py"
autonomous: true
requirements_addressed:
  - "PROJ-ROUTE"
  - "SERV-ROUTE"
  - "AGNT-ROUTE"
  - "E2E-FLOWS"
  - "STG-FLOWS"
must_haves:
  truths:
    - "Projects and Servers endpoints exist, are tenant-isolated, and require appropriate permissions"
    - "Agents router exposes a GET list endpoint for sentinel agents inside tenant scope"
    - "Tenant isolation returns 404 when querying another tenant's resource"
    - "Pytest flow suite passes cleanly with all checks green"
    - "Staging flow verification script successfully validates endpoints on the running Vagrant server"
  artifacts:
    - path: "src/platform_service/app/api/v1/endpoints/projects.py"
    - path: "src/platform_service/app/api/v1/endpoints/servers.py"
    - path: "src/platform_service/app/api/v1/endpoints/agents.py"
    - path: "src/platform_service/tests/test_e2e_flows.py"
    - path: "test-env/verify-platform-flows.py"
---

# Plan 33-01: Flow Testing and Missing APIs for Platform Service

## Objective
Implement missing Projects, Servers, and Agent Listing APIs in the Platform Service, and create automated pytest flow tests and a live staging verification script to test E2E platform flows and schema-isolated tenant security.

---

## Tasks

### Wave 1: API Code Modifications & Mocks Realignment

<task id="33-01-T1">
<name>Create Projects Router and Endpoints</name>
<files>
- src/platform_service/app/api/v1/endpoints/projects.py
- src/platform_service/app/main.py
</files>
<read_first>
- src/platform_service/app/api/v1/endpoints/onboarding.py
- src/platform_service/app/main.py
- database/migrations/001_multi_tenant_onboarding.sql
</read_first>
<action>
1. Create `src/platform_service/app/api/v1/endpoints/projects.py` defining Projects router.
2. Implement Pydantic schema `ProjectCreate` with field `name: str` and `description: Optional[str] = None`.
3. Implement `POST /` to insert a project into `client_{company_slug}.projects`. Route requires `RequirePermission("project.manage")`. Call `await set_tenant_search_path(db, company_slug)`. Return created project details.
4. Implement `GET /` to select and list all projects from `client_{company_slug}.projects`. Route requires `RequirePermission("project.read")`.
5. Import and include projects router in `src/platform_service/app/main.py`:
   `app.include_router(projects.router, prefix="/api/v1/projects", tags=["projects"])`
</action>
<verify>
Grep `projects` router registration in `src/platform_service/app/main.py` and verify file creation.
</verify>
</task>

<task id="33-01-T2">
<name>Create Servers Router and Endpoints</name>
<files>
- src/platform_service/app/api/v1/endpoints/servers.py
- src/platform_service/app/main.py
</files>
<read_first>
- src/platform_service/app/api/v1/endpoints/projects.py
- src/platform_service/app/main.py
- database/migrations/001_multi_tenant_onboarding.sql
</read_first>
<action>
1. Create `src/platform_service/app/api/v1/endpoints/servers.py` defining Servers router.
2. Implement Pydantic schema `ServerCreate` with fields `project_id: str`, `hostname: str`, `ip_address: str`, `status: Optional[str] = "online"`, and `specs: Optional[dict] = {}`.
3. Implement `POST /` to insert a server into `client_{company_slug}.servers`. Route requires `RequirePermission("server.manage")`. Call `await set_tenant_search_path(db, company_slug)`. Verify `project_id` exists in `projects` (raise 404 if not). Return registered server details.
4. Implement `GET /` to select and list all servers from `client_{company_slug}.servers`. Route requires `RequirePermission("server.read")`.
5. Import and include servers router in `src/platform_service/app/main.py`:
   `app.include_router(servers.router, prefix="/api/v1/servers", tags=["servers"])`
</action>
<verify>
Grep `servers` router registration in `src/platform_service/app/main.py` and verify file creation.
</verify>
</task>

<task id="33-01-T3">
<name>Implement Agent Listing API in Agents Router</name>
<files>
- src/platform_service/app/api/v1/endpoints/agents.py
</files>
<read_first>
- src/platform_service/app/api/v1/endpoints/agents.py
- database/migrations/001_multi_tenant_onboarding.sql
</read_first>
<action>
1. Edit `src/platform_service/app/api/v1/endpoints/agents.py` to add a `GET /` route.
2. Route requires `RequirePermission("security.read")` and returns a list of all sentinel agents in `client_{company_slug}.sentinel_agents`.
3. Query selects `id`, `server_id`, `version`, `git_commit`, `status`, `capabilities_proof`, `last_connected_at`, `created_at`, `updated_at` from `client_{company_slug}.sentinel_agents`.
</action>
<verify>
Assert `GET /` endpoint exists in `agents.py` and has security permission checks.
</verify>
</task>

<task id="33-01-T4">
<name>Add Automated Pytest Flow Tests</name>
<files>
- src/platform_service/tests/test_e2e_flows.py
</files>
<read_first>
- src/platform_service/tests/test_endpoints.py
- src/platform_service/tests/conftest.py
</read_first>
<action>
1. Create `src/platform_service/tests/test_e2e_flows.py` using `pytest`.
2. Write integration tests using `httpx.AsyncClient` mapping:
   - Dynamic tenant creation (`POST /api/v1/onboarding/provision`)
   - Creating projects and registering servers under that tenant context
   - Generating Sentinel join token via brokered join endpoint
   - Testing tenant isolation: Authenticate with Tenant A credentials/key and request Tenant B's server details or list servers, asserting `404 Not Found`.
3. Run `pytest` on the new file.
</action>
<verify>
Run `.\venv\Scripts\pytest src/platform_service/tests/test_e2e_flows.py` and assert success.
</verify>
</task>

<task id="33-01-T5">
<name>Create Staging Flow Verification Script</name>
<files>
- test-env/verify-platform-flows.py
</files>
<read_first>
- test-env/verify-ingestion.py
- test-env/gen_token.py
</read_first>
<action>
1. Create `test-env/verify-platform-flows.py` in the workspace.
2. In the script, dynamically generate global administrator JWT token using `jwt.encode` with `test-secret`.
3. Make REST calls to the live running platform service (port 8000 on VM):
   - Provision a tenant `acme-flow`
   - Register a project and a server under the tenant
   - List the projects and servers to verify they exist
   - Attempt cross-tenant requests (using different tenant claim token) and verify it returns `404` status.
</action>
<verify>
Run the script locally or on the Vagrant server VM and check it completes successfully.
</verify>
</task>
