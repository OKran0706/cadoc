-- Platform administrator identity and RBAC for the Cadoc control plane.
-- Admin tables live in public because admins operate across tenant schemas.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS public.admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email CITEXT NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    auth_provider VARCHAR(50) NOT NULL DEFAULT 'local',
    external_subject VARCHAR(255),
    password_hash TEXT,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT admin_users_status_chk CHECK (
        status IN ('active', 'disabled', 'invited')
    ),
    CONSTRAINT admin_users_auth_provider_subject_uniq UNIQUE (
        auth_provider,
        external_subject
    ),
    CONSTRAINT admin_users_auth_source_chk CHECK (
        (auth_provider = 'local' AND password_hash IS NOT NULL)
        OR (auth_provider <> 'local' AND external_subject IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS public.admin_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL UNIQUE,
    scope VARCHAR(20) NOT NULL DEFAULT 'tenant',
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT admin_roles_scope_chk CHECK (scope IN ('global', 'tenant'))
);

CREATE TABLE IF NOT EXISTS public.admin_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_role_permissions (
    role_id UUID NOT NULL REFERENCES public.admin_roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES public.admin_permissions(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS public.admin_user_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID NOT NULL REFERENCES public.admin_users(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES public.admin_roles(id) ON DELETE CASCADE,
    tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID NOT NULL REFERENCES public.admin_users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_user_roles_admin_user_id_idx
    ON public.admin_user_roles (admin_user_id);

CREATE INDEX IF NOT EXISTS admin_user_roles_tenant_id_idx
    ON public.admin_user_roles (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS admin_user_roles_global_uniq
    ON public.admin_user_roles (admin_user_id, role_id)
    WHERE tenant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS admin_user_roles_tenant_uniq
    ON public.admin_user_roles (admin_user_id, role_id, tenant_id)
    WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS admin_api_keys_admin_user_id_idx
    ON public.admin_api_keys (admin_user_id);

CREATE OR REPLACE FUNCTION public.enforce_admin_role_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_scope VARCHAR(20);
BEGIN
    SELECT scope
    INTO v_scope
    FROM public.admin_roles
    WHERE id = NEW.role_id;

    IF v_scope = 'global' AND NEW.tenant_id IS NOT NULL THEN
        RAISE EXCEPTION 'Global admin role assignments must not include tenant_id'
            USING ERRCODE = '23514';
    END IF;

    IF v_scope = 'tenant' AND NEW.tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant admin role assignments must include tenant_id'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS admin_user_roles_enforce_scope ON public.admin_user_roles;
CREATE TRIGGER admin_user_roles_enforce_scope
    BEFORE INSERT OR UPDATE ON public.admin_user_roles
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_admin_role_scope();

DROP TRIGGER IF EXISTS admin_users_touch_updated_at ON public.admin_users;
CREATE TRIGGER admin_users_touch_updated_at
    BEFORE UPDATE ON public.admin_users
    FOR EACH ROW
    EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS admin_roles_touch_updated_at ON public.admin_roles;
CREATE TRIGGER admin_roles_touch_updated_at
    BEFORE UPDATE ON public.admin_roles
    FOR EACH ROW
    EXECUTE FUNCTION public.touch_updated_at();

INSERT INTO public.admin_permissions (code, description)
VALUES
    ('tenant.provision', 'Create and activate tenant schemas.'),
    ('tenant.read', 'Read tenant registry and tenant metadata.'),
    ('tenant.suspend', 'Suspend or restore tenant access.'),
    ('cmdb.read', 'Read tenant CMDB inventory.'),
    ('cmdb.write', 'Modify tenant CMDB inventory.'),
    ('security.read', 'Read tenant Sentinel, decoy, and alert telemetry.'),
    ('security.respond', 'Execute security response actions.'),
    ('admin.manage', 'Manage Cadoc admin users, roles, permissions, and API keys.'),
    ('audit.read', 'Read platform audit logs.')
ON CONFLICT (code) DO UPDATE
SET description = EXCLUDED.description;

INSERT INTO public.admin_roles (name, description)
VALUES
    ('platform_owner', 'Full Cadoc control-plane administration.'),
    ('security_auditor', 'Read-only security and audit visibility across tenants.'),
    ('support_operator', 'Read-only tenant support access.'),
    ('tenant_admin', 'Tenant-scoped CMDB and security administration.')
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description;

UPDATE public.admin_roles
SET scope = CASE
    WHEN name IN ('platform_owner', 'security_auditor', 'support_operator') THEN 'global'
    ELSE 'tenant'
END
WHERE name IN ('platform_owner', 'security_auditor', 'support_operator', 'tenant_admin');

INSERT INTO public.admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.admin_roles r
JOIN public.admin_permissions p ON p.code IN (
    'tenant.provision',
    'tenant.read',
    'tenant.suspend',
    'cmdb.read',
    'cmdb.write',
    'security.read',
    'security.respond',
    'admin.manage',
    'audit.read'
)
WHERE r.name = 'platform_owner'
ON CONFLICT DO NOTHING;

INSERT INTO public.admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.admin_roles r
JOIN public.admin_permissions p ON p.code IN (
    'tenant.read',
    'security.read',
    'audit.read'
)
WHERE r.name = 'security_auditor'
ON CONFLICT DO NOTHING;

INSERT INTO public.admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.admin_roles r
JOIN public.admin_permissions p ON p.code IN (
    'tenant.read',
    'cmdb.read',
    'security.read'
)
WHERE r.name = 'support_operator'
ON CONFLICT DO NOTHING;

INSERT INTO public.admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.admin_roles r
JOIN public.admin_permissions p ON p.code IN (
    'cmdb.read',
    'cmdb.write',
    'security.read',
    'security.respond'
)
WHERE r.name = 'tenant_admin'
ON CONFLICT DO NOTHING;

ALTER TABLE public.global_audit_log
    ADD COLUMN IF NOT EXISTS admin_user_id UUID REFERENCES public.admin_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS global_audit_log_admin_user_id_idx
    ON public.global_audit_log (admin_user_id);

CREATE OR REPLACE FUNCTION public.admin_has_permission(
    p_admin_user_id UUID,
    p_permission_code TEXT,
    p_tenant_id UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.admin_users au
        JOIN public.admin_user_roles aur
            ON aur.admin_user_id = au.id
        JOIN public.admin_role_permissions arp
            ON arp.role_id = aur.role_id
        JOIN public.admin_permissions ap
            ON ap.id = arp.permission_id
        WHERE au.id = p_admin_user_id
          AND au.status = 'active'
          AND ap.code = p_permission_code
          AND (
              aur.tenant_id IS NULL
              OR aur.tenant_id = p_tenant_id
          )
    );
$$;
