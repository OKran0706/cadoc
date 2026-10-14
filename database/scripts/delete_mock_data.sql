\set ON_ERROR_STOP on

\if :{?tenant_slug}
\else
    \set tenant_slug 'mock-acme'
\endif

CREATE TEMP TABLE mock_delete_config AS
SELECT :'tenant_slug'::text AS tenant_slug;

DO $$
DECLARE
    v_slug TEXT;
    v_schema_name TEXT;
    v_tenant_id UUID;
BEGIN
    SELECT tenant_slug
    INTO v_slug
    FROM mock_delete_config;

    IF v_slug !~ '^mock-[a-z0-9][a-z0-9-]*$' THEN
        RAISE EXCEPTION 'Mock delete tenant slug "%" must start with "mock-"', v_slug;
    END IF;

    SELECT id, 'client_' || slug
    INTO v_tenant_id, v_schema_name
    FROM public.tenants
    WHERE slug = v_slug;

    IF v_tenant_id IS NULL THEN
        RAISE NOTICE 'Mock tenant "%" does not exist. Nothing to delete.', v_slug;
        RETURN;
    END IF;

    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', v_schema_name);

    DELETE FROM public.global_audit_log
    WHERE tenant_id = v_tenant_id;

    DELETE FROM public.tenants
    WHERE id = v_tenant_id;

    RAISE NOTICE 'Deleted mock tenant "%", schema "%", and related global audit rows.',
        v_slug,
        v_schema_name;
END;
$$;

SELECT
    :'tenant_slug' AS tenant_slug,
    (SELECT count(*) FROM public.tenants WHERE slug = :'tenant_slug') AS remaining_tenants,
    (SELECT count(*) FROM public.global_audit_log gal WHERE tenant_id NOT IN (SELECT id FROM public.tenants)) AS orphan_audit_events;

DROP TABLE mock_delete_config;
