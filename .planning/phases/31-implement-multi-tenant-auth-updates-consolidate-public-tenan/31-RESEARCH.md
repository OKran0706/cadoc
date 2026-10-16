# Phase 31 Research: Multi-Tenant Federated Auth Schema Consolidation

## 1. Migration Strategy (SQL)
To implement the federated auth model, we need to create `database/migrations/006_consolidate_auth_schema.sql` which does the following:

### A. Central Public Schema Clean-Up & Consolidation
- **Drop Tables**: Drop the old over-engineered tables in `public`:
  - `public.admin_api_keys`
  - `public.admin_user_roles`
  - `public.admin_role_permissions`
  - `public.admin_roles`
  - `public.admin_permissions`
  - `public.admin_users` (recreated as `global_admins`)
- **Create Tables**:
  - `public.global_admins` (id, email, display_name, status, password_hash, timestamps)
  - `public.global_api_keys` (id, admin_id REFERENCES global_admins, name, key_hash, timestamps)

### B. Dynamic Tenant provisioning updates
Modify the `public.provision_tenant` database function to create isolated local tables under the new `client_<slug>` schema:
- **`client_<slug>.users`**: Local user identity.
- **`client_<slug>.roles`**: Local roles and permissions (using `JSONB` array/object).
- **`client_<slug>.user_roles`**: Maps local users to local roles.
- **`client_<slug>.api_keys`**: Local API keys.

---

## 2. API Key Prefix Routing Logic
Instead of a global search over all tenant schemas, API keys will carry a prefix:
- Global key: `cadoc_g_xxxxxxxxxxxx`
- Tenant key: `cadoc_t_{slug}_xxxxxxxxxxxx`

The verification dependency extracts the prefix to immediately switch search path to the appropriate tenant schema and performs a single indexed lookup.

---

## 3. FastAPI Login Endpoint refactoring (`auth.py`)
The `/login` route must authenticate:
- **Global Admins**: If `company_slug == "global"`, queries `public.global_admins`.
- **Tenant Users**: If `company_slug != "global"`, switches `search_path` to `client_{company_slug}` and queries the local `users` table.

---

## 4. Validation Architecture
- **Unit Tests**: Add tests verifying:
  - Global admin JWT login.
  - Tenant user login with correct `company_slug` body param.
  - Global API key header validation (routes to `public.global_api_keys`).
  - Tenant-scoped API key header validation (extracts prefix, routes to local `client_<slug>.api_keys`).
  - Access is denied if a tenant key is used on a different tenant schema.
  - Deleting a tenant (`DROP SCHEMA client_<slug> CASCADE`) drops all of its users, roles, and keys.
