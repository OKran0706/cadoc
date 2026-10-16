# Phase 31: Implement multi-tenant auth updates (consolidate public/tenant schemas) - Context

**Gathered:** 2026-06-11
**Status:** Ready for planning
**Source:** Chat Discussion

<domain>
## Phase Boundary
Implement the federated multi-tenant authorization data model where:
- Platform administrators live in a single table `public.global_admins` with platform-wide scope.
- Tenant administrators and users live in local `users`, `roles`, and `user_roles` tables inside each isolated tenant schema `client_<company_slug>`.
- API keys are also split: `public.global_api_keys` for global admins, and `client_<company_slug>.api_keys` for tenant users.
- Self-describing API key prefixes (e.g. `cadoc_g_` for global, `cadoc_t_{slug}_` for tenant) route key lookup dynamically without global scanning.
</domain>

<decisions>
## Implementation Decisions

### 1. Database Table Consolidation
- Create a migration `database/migrations/006_consolidate_auth_schema.sql` to drop the old platform-wide RBAC tables in public: `public.admin_roles`, `public.admin_permissions`, `public.admin_role_permissions`, `public.admin_user_roles`, and `public.admin_api_keys`.
- Replace them with:
  - `public.global_admins` — centralized platform identity
  - `public.global_api_keys` — centralized platform programmatic keys (referencing `public.global_admins`)
  - A new routing helper or check `public.admin_has_permission` modified to evaluate global admin permissions from hardcoded code-based roles.
- Create local tables in each dynamically provisioned tenant schema `client_<slug>` by updating `public.provision_tenant`:
  - `users` — local user identity
  - `roles` — local role names and permission lists (using a GIN indexed `JSONB` column or `JSONB` array)
  - `user_roles` — M:N mapping of local users to local roles
  - `api_keys` — tenant-scoped keys (referencing local `users`)

### 2. Prefix-Based API Key Verification
- Implement a FastAPI dependency/handler `verify_api_key` that:
  - Inspects key prefixes (`cadoc_g_` for global, `cadoc_t_{slug}_` for tenant).
  - Routes global lookups directly to `public.global_api_keys`.
  - Parses `{slug}` for tenant keys, sets `set_tenant_search_path({slug})`, hashes the key, and queries `client_<slug>.api_keys` locally.

</decisions>

<canonical_refs>
## Canonical References
- `database/migrations/001_multi_tenant_onboarding.sql` — original tenant schema creation
- `database/migrations/002_admin_rbac.sql` — original platform auth tables
- `database/migrations/005_alert_mitigations.sql` — current active migration
- `src/platform_service/app/api/v1/endpoints/auth.py` — platform auth endpoints
- `src/platform_service/app/api/v1/endpoints/bootstrap.py` — agent bootstrap endpoints
- `src/platform_service/app/core/security.py` — core authentication helper functions
</canonical_refs>

<specifics>
## Specific Ideas
Ensure that when a tenant is deleted via `DROP SCHEMA client_<slug> CASCADE`, all tenant users, roles, and API keys are automatically dropped with it.
</specifics>

<deferred>
## Deferred Ideas
SSO/OIDC third-party integration is deferred to a future milestone.
</deferred>
