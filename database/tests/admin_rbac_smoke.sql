\set ON_ERROR_STOP on

SELECT public.provision_tenant('rbac-acme', 'RBAC Acme Corporation') AS tenant_id;

INSERT INTO public.admin_users (
    email,
    display_name,
    auth_provider,
    password_hash
)
VALUES (
    'owner@cadoc.local',
    'Cadoc Owner',
    'local',
    '$argon2id$v=19$m=65536,t=3,p=4$mock-salt$mock-hash'
)
ON CONFLICT (email) DO UPDATE
SET display_name = EXCLUDED.display_name
RETURNING id;

INSERT INTO public.admin_users (
    email,
    display_name,
    auth_provider,
    external_subject
)
VALUES (
    'tenant-admin@acme.local',
    'Acme Tenant Admin',
    'oidc',
    'oidc|acme|tenant-admin'
)
ON CONFLICT (email) DO UPDATE
SET display_name = EXCLUDED.display_name
RETURNING id;

INSERT INTO public.admin_user_roles (admin_user_id, role_id)
SELECT au.id, ar.id
FROM public.admin_users au
JOIN public.admin_roles ar ON ar.name = 'platform_owner'
WHERE au.email = 'owner@cadoc.local'
ON CONFLICT DO NOTHING;

INSERT INTO public.admin_user_roles (admin_user_id, role_id, tenant_id)
SELECT au.id, ar.id, t.id
FROM public.admin_users au
JOIN public.admin_roles ar ON ar.name = 'tenant_admin'
JOIN public.tenants t ON t.slug = 'rbac-acme'
WHERE au.email = 'tenant-admin@acme.local'
ON CONFLICT DO NOTHING;

DO $$
DECLARE
    v_owner_id UUID;
    v_tenant_admin_id UUID;
    v_tenant_id UUID;
    v_platform_role_id UUID;
    v_tenant_role_id UUID;
BEGIN
    SELECT id INTO v_owner_id
    FROM public.admin_users
    WHERE email = 'owner@cadoc.local';

    SELECT id INTO v_tenant_admin_id
    FROM public.admin_users
    WHERE email = 'tenant-admin@acme.local';

    SELECT id INTO v_tenant_id
    FROM public.tenants
    WHERE slug = 'rbac-acme';

    SELECT id INTO v_platform_role_id
    FROM public.admin_roles
    WHERE name = 'platform_owner';

    SELECT id INTO v_tenant_role_id
    FROM public.admin_roles
    WHERE name = 'tenant_admin';

    IF NOT public.admin_has_permission(v_owner_id, 'admin.manage') THEN
        RAISE EXCEPTION 'Platform owner should have admin.manage';
    END IF;

    IF NOT public.admin_has_permission(v_owner_id, 'tenant.provision', v_tenant_id) THEN
        RAISE EXCEPTION 'Platform owner should have tenant.provision';
    END IF;

    IF public.admin_has_permission(v_tenant_admin_id, 'tenant.provision', v_tenant_id) THEN
        RAISE EXCEPTION 'Tenant admin should not have tenant.provision';
    END IF;

    IF NOT public.admin_has_permission(v_tenant_admin_id, 'cmdb.write', v_tenant_id) THEN
        RAISE EXCEPTION 'Tenant admin should have tenant-scoped cmdb.write';
    END IF;

    BEGIN
        INSERT INTO public.admin_user_roles (admin_user_id, role_id, tenant_id)
        VALUES (v_owner_id, v_platform_role_id, v_tenant_id);
        RAISE EXCEPTION 'Global role with tenant scope unexpectedly succeeded';
    EXCEPTION
        WHEN check_violation THEN
            NULL;
    END;

    BEGIN
        INSERT INTO public.admin_user_roles (admin_user_id, role_id)
        VALUES (v_tenant_admin_id, v_tenant_role_id);
        RAISE EXCEPTION 'Tenant role without tenant scope unexpectedly succeeded';
    EXCEPTION
        WHEN check_violation THEN
            NULL;
    END;

    INSERT INTO public.global_audit_log (
        tenant_id,
        admin_user_id,
        event_type,
        payload
    )
    VALUES (
        v_tenant_id,
        v_owner_id,
        'ADMIN_RBAC_SMOKE_TEST',
        '{"ok": true}'::jsonb
    );
END;
$$;

SELECT
    (SELECT count(*) FROM public.admin_users) AS admin_users,
    (SELECT count(*) FROM public.admin_roles) AS admin_roles,
    (SELECT count(*) FROM public.admin_permissions) AS admin_permissions,
    (SELECT count(*) FROM public.admin_user_roles) AS admin_user_roles,
    (SELECT count(*) FROM public.global_audit_log WHERE event_type = 'ADMIN_RBAC_SMOKE_TEST') AS admin_audit_events;
