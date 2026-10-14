# CMDB Database

This folder contains the PostgreSQL 15+ schema-based multi-tenant CMDB migration.

Apply the migration as the platform database owner:

```sql
\i database/migrations/001_multi_tenant_onboarding.sql
\i database/migrations/002_admin_rbac.sql
```

Provision a tenant through the single onboarding entry point:

```sql
SELECT public.provision_tenant('acme-corp', 'Acme Corporation');
```

Route application requests by setting the tenant schema on each connection lease:

```sql
BEGIN;
SELECT public.set_tenant_search_path('acme-corp');
-- Tenant-local queries now resolve against "client_acme-corp", then public.
COMMIT;
```

For session-level routing outside a transaction wrapper, pass `false`:

```sql
SELECT public.set_tenant_search_path('acme-corp', false);
```

Run the smoke test after applying the migration:

```sql
\i database/tests/provision_tenant_smoke.sql
\i database/tests/admin_rbac_smoke.sql
```

Cadoc platform admins are modeled in `public`, separate from tenant schemas:

- `admin_users` stores admin identity metadata. Use `auth_provider` /
  `external_subject` for SSO/OIDC identities, or `password_hash` for local auth.
- `admin_roles` separates global roles from tenant-scoped roles.
- `admin_permissions` stores stable permission codes such as `tenant.provision`,
  `cmdb.write`, `security.read`, and `admin.manage`.
- `admin_user_roles` assigns roles either globally or to a specific tenant.
- `admin_api_keys` stores hashed automation keys for admin service accounts.
- `admin_has_permission(...)` gives the application one database-side permission
  check for global and tenant-scoped admin actions.

Seed and remove dashboard-friendly mock data:

```sql
\set tenant_slug 'mock-acme'
\set tenant_name 'Mock Acme Corporation'
\i database/scripts/seed_mock_data.sql
\i database/scripts/delete_mock_data.sql
```

The delete script drops only the mock tenant schema and its matching
`public.tenants` / `public.global_audit_log` rows. This preserves the immutable
behavior of tenant `tamper_alerts` instead of deleting alert records directly.
Both mock scripts require the tenant slug to start with `mock-`; the seed script
resets that mock tenant first, so it is safe to rerun without duplicate rows.

The provisioning function creates `public.tenants`, `public.global_audit_log`, a
tenant schema named `client_<slug>`, tenant CMDB tables, Canary security telemetry
tables, indexes for real-time dashboards, and `updated_at` triggers. PostgreSQL
functions execute atomically in the caller's transaction, so a provisioning failure
rolls back the tenant row, audit rows, schema, tables, indexes, and triggers.

Partitioning is applied only where it helps operationally:

- `public.global_audit_log` is monthly range-partitioned on `created_at`.
- Each tenant's `tamper_alerts` table is monthly range-partitioned on `detected_at`.
- Current-month, next-month, and default partitions are created automatically.
- Current-state tables such as `sentinel_agents` and `canary_decoy_files` stay
  unpartitioned and use targeted indexes for heartbeat/status dashboard queries.
