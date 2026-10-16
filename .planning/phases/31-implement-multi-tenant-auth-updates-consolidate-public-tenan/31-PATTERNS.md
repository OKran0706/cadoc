# Phase 31: Implement multi-tenant auth updates (consolidate public/tenant schemas) - Patterns

This document maps out codebase analogs, patterns, and code snippets to guide the implementation of Phase 31.

---

## 1. Schema Migrations with Schema Loops (SQL)

### Closest Analog: Dynamic client migration loop in `database/migrations/005_alert_mitigations.sql`

#### Pattern to Replicate:
We will write a PL/pgSQL block to iterate over existing tenant schemas and provision the new users/roles/keys tables, while dropping obsolete tables.

```sql
-- Analogue from database/migrations/005_alert_mitigations.sql
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN 
        SELECT schema_name 
        FROM information_schema.schemata 
        WHERE schema_name LIKE 'client_%'
    LOOP
        EXECUTE format($ddl$
            CREATE TABLE IF NOT EXISTS %I.alert_mitigations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                alert_id UUID NOT NULL UNIQUE,
                ...
            )
        $ddl$, r.schema_name);
    END LOOP;
END;
$$;
```

---

## 2. API Key Prefix Verification and Dynamic Routing

### Closest Analog: `RequirePermission` in `src/platform_service/app/core/security.py`

#### Pattern to Replicate:
Parse the prefix of `X-API-Key` to determine whether to query global tables or scope to a tenant schema connection.

```python
# New implementation pattern for RequirePermission API Key check:
if api_key:
    if api_key.startswith("cadoc_g_"):
        # Global key
        raw_secret = api_key.removeprefix("cadoc_g_")
        hashed_key = hashlib.sha256(raw_secret.encode()).hexdigest()
        res = await db.execute(
            text("SELECT id, admin_id FROM public.global_api_keys WHERE key_hash = :hash AND revoked_at IS NULL"),
            {"hash": hashed_key}
        )
        # Verify and authenticate as global admin...
    elif api_key.startswith("cadoc_t_"):
        # Tenant key
        parts = api_key.split("_") # ['cadoc', 't', 'company-slug', 'secret']
        company_slug = parts[2]
        raw_secret = parts[-1]
        hashed_key = hashlib.sha256(raw_secret.encode()).hexdigest()
        
        # Switch search path to target tenant
        await set_tenant_search_path(db, company_slug)
        
        # Query local client_slug.api_keys table
        res = await db.execute(
            text("SELECT id, user_id FROM api_keys WHERE key_hash = :hash AND revoked_at IS NULL"),
            {"hash": hashed_key}
        )
```

---

## 3. Login Endpoint Refactoring

### Closest Analog: `/login` in `src/platform_service/app/api/v1/endpoints/auth.py`

#### Pattern to Replicate:
Update the route to accept `company_slug` from body payload and route login verification accordingly.

```python
# New implementation pattern:
if req.company_slug == "global":
    # Authenticate platform admin in public.global_admins
    result = await db.execute(
        text("SELECT id, email, password_hash FROM public.global_admins WHERE email = :email AND status = 'active'"),
        {"email": req.email}
    )
else:
    # Switch connection search path to client schema
    await set_tenant_search_path(db, req.company_slug)
    # Authenticate tenant user in client_<slug>.users
    result = await db.execute(
        text("SELECT id, email, password_hash FROM users WHERE email = :email"),
        {"email": req.email}
    )
```

---

*Phase: 31-implement-multi-tenant-auth-updates-consolidate-public-tenan*
*Patterns gathered: 2026-06-11*
