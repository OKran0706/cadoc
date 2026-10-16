---
plan: "31-01"
phase: 31
type: "standard"
wave: 1
depends_on: []
files_modified:
  - "database/migrations/006_consolidate_auth_schema.sql"
  - "src/platform_service/app/core/security.py"
  - "src/platform_service/app/api/v1/endpoints/auth.py"
  - "src/platform_service/tests/test_security.py"
autonomous: true
requirements_addressed:
  - "AUTH-MIG"
  - "KEY-ROUTE"
  - "AUTH-LOGIN"
  - "RBAC-CHECK"
  - "DEP-CLEANUP"
must_haves:
  truths:
    - "Dynamic tenant routing scopes queries using search path transactions for dashboard queries"
    - "Auth schema is consolidated to 3 core tables for global admins and client-scoped tables for tenants"
    - "Global API keys use prefix cadoc_g_ and route to public.global_api_keys"
    - "Tenant API keys use prefix cadoc_t_{slug}_ and route dynamically to client_{slug}.api_keys"
    - "FastAPI login validates platform credentials against public.global_admins and tenant credentials against client_{slug}.users"
    - "Dropping a tenant schema cascaded drops all local users, roles, and keys"
  artifacts:
    - path: "database/migrations/006_consolidate_auth_schema.sql"
    - path: "src/platform_service/app/core/security.py"
    - path: "src/platform_service/app/api/v1/endpoints/auth.py"
    - path: "src/platform_service/tests/test_security.py"
---

# Plan 31-01: Federated Multi-Tenant Auth Schema Consolidation

## Objective
Consolidate the platform authorization architecture by moving static permission definitions to code, dropping the over-engineered platform-wide RBAC tables in public, and introducing a federated auth structure. This includes central global tables, tenant-isolated users/roles/keys inside schemas, prefix-based dynamic API key lookup and routing, and API endpoint upgrades.

---

## Tasks

### Wave 1: Database Migrations & Test Foundation

<task id="31-01-T1">
<name>Create Federated Auth Schema Migration</name>
<files>
- database/migrations/006_consolidate_auth_schema.sql
- database/migrations/001_multi_tenant_onboarding.sql
- database/migrations/002_admin_rbac.sql
</files>
<action>
Create `database/migrations/006_consolidate_auth_schema.sql` to consolidate the platform identity tables. It must:
1. Drop the old public RBAC tables: `public.admin_api_keys`, `public.admin_user_roles`, `public.admin_role_permissions`, `public.admin_roles`, `public.admin_permissions`, and `public.admin_users`.
2. Create platform central tables:
   - `public.global_admins` with fields: `id UUID PRIMARY KEY`, `email CITEXT NOT NULL UNIQUE`, `display_name VARCHAR(255) NOT NULL`, `status VARCHAR(20) NOT NULL DEFAULT 'active'`, `password_hash TEXT NOT NULL`, and standard timestamps.
   - `public.global_api_keys` with fields: `id UUID PRIMARY KEY`, `admin_id UUID NOT NULL REFERENCES public.global_admins(id) ON DELETE CASCADE`, `name VARCHAR(100) NOT NULL`, `key_hash TEXT NOT NULL UNIQUE`, and standard timestamps.
3. Update/recreate the `public.provision_tenant` database function to create isolated tenant tables under each new `client_<slug>` schema:
   - `users` (id, email, display_name, password_hash, timestamps)
   - `roles` (id, name, permissions JSONB, timestamps)
   - `user_roles` (user_id FK, role_id FK, PRIMARY KEY (user_id, role_id))
   - `api_keys` (id, user_id FK, name, key_hash, timestamps)
4. Add a migration loop to dynamically provision these tables for all existing tenant schemas (`client_%`) and seed initial roles.
</action>
<verify>
Ensure `database/migrations/006_consolidate_auth_schema.sql` contains correct table schema definitions, updated `public.provision_tenant` logic, and schema migration loops.
</verify>
<done>
- Migration file `database/migrations/006_consolidate_auth_schema.sql` created successfully.
- Schema creation code for both public and client namespaces verified.
</done>
</task>

<task id="31-01-T2">
<name>Setup Integration Test Suite Foundation</name>
<files>
- src/platform_service/tests/test_security.py
</files>
<action>
Create `src/platform_service/tests/test_security.py` detailing mock-based integration tests for the new federated authentication and authorization system:
- Test JWT login for global admins and tenant users.
- Test prefix-based API key verification (both `cadoc_g_` and `cadoc_t_{slug}_`).
- Test permission checking via `RequirePermission` guards.
- Test database cascading cleanup (dropping client schema drops local users and keys).
</action>
<verify>
Run the test suite using `pytest` to see that it runs and fails on unimplemented features (RED gate).
</verify>
<done>
- Test file `src/platform_service/tests/test_security.py` created.
- Command `pytest src/platform_service/tests/test_security.py` executes.
</done>
</task>

---

### Wave 2: Security & Authentication Implementation

<task id="31-01-T3">
<name>Implement Prefix-Based API Key Verification Routing</name>
<files>
- src/platform_service/app/core/security.py
</files>
<action>
Modify `RequirePermission.__call__` in `src/platform_service/app/core/security.py`:
1. Check the `X-API-Key` value.
2. If it starts with `cadoc_g_`:
   - Extract raw secret and query its SHA-256 hash in `public.global_api_keys`.
   - Resolve user context as global admin (company_slug = "global").
3. If it starts with `cadoc_t_`:
   - Split key by `_` to extract company_slug and secret token.
   - Switch transaction search path dynamically: `await set_tenant_search_path(db, company_slug)`.
   - Hash secret and query local `api_keys` inside the tenant schema.
   - Resolve user context as tenant-scoped user.
</action>
<verify>
Run `pytest src/platform_service/tests/test_security.py -k test_api_key_routing`.
</verify>
<done>
- Prefix extraction and routing logic implemented in `RequirePermission`.
- API Key lookup tests pass.
</done>
</task>

<task id="31-01-T4">
<name>Refactor User Login Endpoint for Global & Tenant Scopes</name>
<files>
- src/platform_service/app/api/v1/endpoints/auth.py
- src/platform_service/app/core/security.py
</files>
<action>
Modify `/login` route in `src/platform_service/app/api/v1/endpoints/auth.py`:
1. Expand `LoginRequest` body schema to accept `company_slug` (defaulting to `"global"`).
2. If `company_slug == "global"`, authenticate user against `public.global_admins`.
3. If `company_slug != "global"`, set search path: `await set_tenant_search_path(db, company_slug)` and authenticate against local `users` table.
4. Set JWT claims: `company_slug` should match input slug, and `sub` should match user UUID.
</action>
<verify>
Run `pytest src/platform_service/tests/test_security.py -k test_federated_login`.
</verify>
<done>
- User login upgraded to support dual global/tenant namespaces.
- Authenticated JWT claims successfully verify.
</done>
</task>

<task id="31-01-T5">
<name>Implement Scoped Permissions Verification</name>
<files>
- src/platform_service/app/core/security.py
</files>
<action>
Update permission validation check in `RequirePermission` inside `src/platform_service/app/core/security.py`:
1. If `company_slug == "global"` (Platform Admin):
   - Check if user exists in `public.global_admins` and is active.
   - Platform admins bypass local RBAC check and are granted full access.
2. If `company_slug != "global"` (Tenant User):
   - Query local `user_roles` and `roles` inside the current schema to verify if the user is assigned a role containing the target permission code.
3. Keep Redis permission caching, scoped by `user_id`, `permission_code`, and `tenant_id`.
</action>
<verify>
Run `pytest src/platform_service/tests/test_security.py -k test_federated_permissions`.
</verify>
<done>
- Scoped user permissions verified via local schema tables.
- Redis caching logic successfully updated.
</done>
</task>
