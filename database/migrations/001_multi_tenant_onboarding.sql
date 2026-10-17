-- PostgreSQL 15+ schema-based multi-tenant CMDB onboarding.
-- Run this migration as the platform database owner/super-admin.

-- Create the required monitoring role if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'canary_monitor') THEN
        CREATE ROLE canary_monitor LOGIN PASSWORD 'canary_dev_password';
    END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS public.tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'provisioning',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tenants_slug_format_chk CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
    CONSTRAINT tenants_status_chk CHECK (
        status IN ('provisioning', 'active', 'suspended', 'archived')
    )
);

CREATE TABLE IF NOT EXISTS public.global_audit_log (
    id BIGSERIAL NOT NULL,
    tenant_id UUID REFERENCES public.tenants(id),
    event_type VARCHAR(50) NOT NULL,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS global_audit_log_tenant_id_idx
    ON public.global_audit_log (tenant_id);

CREATE INDEX IF NOT EXISTS global_audit_log_created_at_idx
    ON public.global_audit_log (created_at);

CREATE INDEX IF NOT EXISTS global_audit_log_tenant_created_at_idx
    ON public.global_audit_log (tenant_id, created_at DESC);

-- Platform Centralized Admin Tables
CREATE TABLE public.global_admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email CITEXT NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT global_admins_status_chk CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE public.global_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID NOT NULL REFERENCES public.global_admins(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.ensure_monthly_range_partition(
    p_parent_schema TEXT,
    p_parent_table TEXT,
    p_for_timestamp TIMESTAMPTZ DEFAULT now()
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_month_start DATE := date_trunc('month', p_for_timestamp)::date;
    v_month_end DATE := (date_trunc('month', p_for_timestamp) + interval '1 month')::date;
    v_partition_name TEXT := p_parent_table || '_' || to_char(date_trunc('month', p_for_timestamp), 'YYYY_MM');
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
        p_parent_schema,
        v_partition_name,
        p_parent_schema,
        p_parent_table,
        v_month_start,
        v_month_end
    );

    RETURN format('%I.%I', p_parent_schema, v_partition_name);
END;
$$;

SELECT public.ensure_monthly_range_partition('public', 'global_audit_log', now());
SELECT public.ensure_monthly_range_partition('public', 'global_audit_log', now() + interval '1 month');

CREATE TABLE IF NOT EXISTS public.global_audit_log_default
    PARTITION OF public.global_audit_log DEFAULT;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.deny_immutable_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '%.% is immutable', TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS tenants_touch_updated_at ON public.tenants;
CREATE TRIGGER tenants_touch_updated_at
    BEFORE UPDATE ON public.tenants
    FOR EACH ROW
    EXECUTE FUNCTION public.touch_updated_at();

-- Trigger for public.global_admins updated_at
DROP TRIGGER IF EXISTS global_admins_touch_updated_at ON public.global_admins;
CREATE TRIGGER global_admins_touch_updated_at
    BEFORE UPDATE ON public.global_admins
    FOR EACH ROW
    EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.set_tenant_search_path(
    p_slug VARCHAR,
    p_is_local BOOLEAN DEFAULT true
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_slug VARCHAR(50) := btrim(p_slug);
    v_schema_name TEXT;
BEGIN
    SELECT 'client_' || slug
    INTO v_schema_name
    FROM public.tenants
    WHERE slug = v_slug
      AND status = 'active';

    IF v_schema_name IS NULL THEN
        RAISE EXCEPTION 'Active tenant slug "%" was not found', v_slug
            USING ERRCODE = '3F000';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_namespace
        WHERE nspname = v_schema_name
    ) THEN
        RAISE EXCEPTION 'Tenant schema "%" was not found', v_schema_name
            USING ERRCODE = '3F000';
    END IF;

    PERFORM set_config('search_path', format('%I, public', v_schema_name), p_is_local);
    RETURN v_schema_name;
END;
$$;

-- Consolidated permission evaluation function
CREATE OR REPLACE FUNCTION public.admin_has_permission(
    p_admin_user_id UUID,
    p_permission_code TEXT,
    p_tenant_id UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_exists BOOLEAN;
    v_slug VARCHAR(50);
    v_schema_name TEXT;
    v_has_perm BOOLEAN := false;
BEGIN
    -- 1. Check if user is a global admin
    SELECT EXISTS (
        SELECT 1 FROM public.global_admins 
        WHERE id = p_admin_user_id AND status = 'active'
    ) INTO v_exists;
    
    IF v_exists THEN
        -- Global admins bypass local RBAC and have full platform-wide permission
        RETURN true;
    END IF;

    -- 2. If tenant_id is supplied, check tenant-specific local tables
    IF p_tenant_id IS NOT NULL THEN
        SELECT slug INTO v_slug FROM public.tenants WHERE id = p_tenant_id AND status = 'active';
        IF v_slug IS NOT NULL THEN
            v_schema_name := 'client_' || v_slug;
            EXECUTE format($query$
                SELECT EXISTS (
                    SELECT 1 
                    FROM %I.users u
                    JOIN %I.user_roles ur ON ur.user_id = u.id
                    JOIN %I.roles r ON r.id = ur.role_id
                    WHERE u.id = $1 
                      AND r.permissions ? $2
                )
            $query$, v_schema_name, v_schema_name, v_schema_name)
            USING p_admin_user_id, p_permission_code
            INTO v_has_perm;
        END IF;
    END IF;

    RETURN v_has_perm;
END;
$$;

-- Consolidated tenant provisioning function
CREATE OR REPLACE FUNCTION public.provision_tenant(
    p_slug VARCHAR,
    p_name VARCHAR
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_slug VARCHAR(50) := btrim(p_slug);
    v_name VARCHAR(255) := btrim(p_name);
    v_tenant_id UUID;
    v_schema_name TEXT;
BEGIN
    IF v_slug IS NULL OR v_slug = '' THEN
        RAISE EXCEPTION 'Tenant slug must be non-empty'
            USING ERRCODE = '22023';
    END IF;

    IF v_slug !~ '^[a-z0-9][a-z0-9-]*$' THEN
        RAISE EXCEPTION
            'Invalid tenant slug "%". Use lowercase letters, numbers, and hyphens only; it must start with a letter or number.',
            v_slug
            USING ERRCODE = '22023';
    END IF;

    IF length(v_slug) > 50 THEN
        RAISE EXCEPTION 'Tenant slug must be 50 characters or fewer'
            USING ERRCODE = '22023';
    END IF;

    IF v_name IS NULL OR v_name = '' THEN
        RAISE EXCEPTION 'Tenant name must be non-empty'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('tenant:' || v_slug, 0));

    IF EXISTS (SELECT 1 FROM public.tenants WHERE slug = v_slug) THEN
        RAISE EXCEPTION 'Tenant slug "%" already exists', v_slug
            USING ERRCODE = '23505';
    END IF;

    v_schema_name := 'client_' || v_slug;

    INSERT INTO public.tenants (slug, name, status)
    VALUES (v_slug, v_name, 'provisioning')
    RETURNING id INTO v_tenant_id;

    INSERT INTO public.global_audit_log (tenant_id, event_type, payload)
    VALUES (
        v_tenant_id,
        'CLIENT_PROVISION_START',
        jsonb_build_object('schema_name', v_schema_name)
    );

    EXECUTE format('CREATE SCHEMA %I', v_schema_name);

    -- Local Auth Tables
    EXECUTE format($ddl$
        CREATE TABLE %I.users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email CITEXT NOT NULL UNIQUE,
            display_name VARCHAR(255) NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    $ddl$, v_schema_name);

    EXECUTE format($ddl$
        CREATE TABLE %I.roles (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(50) NOT NULL UNIQUE,
            permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    $ddl$, v_schema_name);

    EXECUTE format($ddl$
        CREATE TABLE %I.user_roles (
            user_id UUID NOT NULL REFERENCES %I.users(id) ON DELETE CASCADE,
            role_id UUID NOT NULL REFERENCES %I.roles(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (user_id, role_id)
        )
    $ddl$, v_schema_name, v_schema_name, v_schema_name);

    EXECUTE format($ddl$
        CREATE TABLE %I.api_keys (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES %I.users(id) ON DELETE CASCADE,
            name VARCHAR(100) NOT NULL,
            key_hash TEXT NOT NULL UNIQUE,
            last_used_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            revoked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    $ddl$, v_schema_name, v_schema_name);

    -- Local App tables
    EXECUTE format($ddl$
        CREATE TABLE %I.projects (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(100) NOT NULL UNIQUE,
            description TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    $ddl$, v_schema_name);

    EXECUTE format($ddl$
        CREATE TABLE %I.servers (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id UUID NOT NULL REFERENCES %I.projects(id) ON DELETE CASCADE,
            hostname VARCHAR(255) NOT NULL UNIQUE,
            ip_address INET NOT NULL,
            status VARCHAR(30) NOT NULL,
            specs JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT servers_status_chk CHECK (status IN ('online', 'offline', 'maintenance', 'provisioning', 'pending'))
        )
    $ddl$, v_schema_name, v_schema_name);

    EXECUTE format($ddl$
        CREATE TABLE %I.server_roles (
            server_id UUID NOT NULL REFERENCES %I.servers(id) ON DELETE CASCADE,
            role_id UUID NOT NULL REFERENCES %I.roles(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (server_id, role_id)
        )
    $ddl$, v_schema_name, v_schema_name, v_schema_name);

    EXECUTE format($ddl$
        CREATE TABLE %I.sentinel_agents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            server_id UUID NOT NULL REFERENCES %I.servers(id) ON DELETE CASCADE,
            version VARCHAR(30) NOT NULL,
            git_commit VARCHAR(40) NOT NULL,
            status VARCHAR(20) NOT NULL,
            capabilities_proof JSONB NOT NULL DEFAULT '{}'::jsonb,
            last_connected_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT sentinel_agents_status_chk CHECK (status IN ('active', 'offline', 'degraded', 'decommissioned'))
        )
    $ddl$, v_schema_name, v_schema_name);

    EXECUTE format($ddl$
        CREATE TABLE %I.canary_decoy_files (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            server_id UUID NOT NULL REFERENCES %I.servers(id) ON DELETE CASCADE,
            file_path VARCHAR(512) NOT NULL,
            decoy_type VARCHAR(50) NOT NULL,
            original_hash VARCHAR(64) NOT NULL,
            status VARCHAR(30) NOT NULL,
            planted_at TIMESTAMPTZ NOT NULL,
            last_verified TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT canary_decoy_files_hash_chk CHECK (original_hash ~ '^[A-Fa-f0-9]{64}$'),
            CONSTRAINT canary_decoy_files_status_chk CHECK (status IN ('planted', 'tampered', 'cleaned_up', 'verification_failed'))
        )
    $ddl$, v_schema_name, v_schema_name);

    EXECUTE format($ddl$
        CREATE TABLE %I.tamper_alerts (
            id UUID NOT NULL DEFAULT gen_random_uuid(),
            server_id UUID NOT NULL REFERENCES %I.servers(id) ON DELETE CASCADE,
            agent_id UUID REFERENCES %I.sentinel_agents(id) ON DELETE SET NULL,
            event_type VARCHAR(50) NOT NULL,
            severity VARCHAR(20) NOT NULL,
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            detected_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (id, detected_at),
            CONSTRAINT tamper_alerts_event_type_chk CHECK (event_type IN ('DECOY_TAMPER', 'BINARY_TAMPER', 'AUDITD_RULE_DELETED', 'SYSTEM_INTEGRITY_FAIL')),
            CONSTRAINT tamper_alerts_severity_chk CHECK (severity IN ('low', 'medium', 'high', 'critical'))
        ) PARTITION BY RANGE (detected_at)
    $ddl$, v_schema_name, v_schema_name, v_schema_name);

    PERFORM public.ensure_monthly_range_partition(v_schema_name, 'tamper_alerts', now());
    PERFORM public.ensure_monthly_range_partition(v_schema_name, 'tamper_alerts', now() + interval '1 month');

    EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %I.tamper_alerts DEFAULT',
        v_schema_name, 'tamper_alerts_default', v_schema_name
    );

    EXECUTE format($ddl$
        CREATE TABLE %I.alert_mitigations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            alert_id UUID NOT NULL UNIQUE,
            analyst_user_id UUID,
            mitigation_notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    $ddl$, v_schema_name);

    -- Creating Indexes
    EXECUTE format('CREATE INDEX %I ON %I.users (email)', 'users_email_idx', v_schema_name);
    EXECUTE format('CREATE INDEX %I ON %I.api_keys (key_hash)', 'api_keys_key_hash_idx', v_schema_name);
    EXECUTE format('CREATE INDEX %I ON %I.servers (project_id)', 'servers_project_id_idx', v_schema_name);
    EXECUTE format('CREATE INDEX %I ON %I.server_roles (role_id)', 'server_roles_role_id_idx', v_schema_name);
    EXECUTE format('CREATE INDEX %I ON %I.sentinel_agents (server_id)', 'sentinel_agents_server_id_idx', v_schema_name);
    EXECUTE format('CREATE INDEX %I ON %I.sentinel_agents (last_connected_at)', 'sentinel_agents_last_connected_at_idx', v_schema_name);
    EXECUTE format('CREATE INDEX %I ON %I.canary_decoy_files (server_id)', 'canary_decoy_files_server_id_idx', v_schema_name);
    EXECUTE format('CREATE INDEX %I ON %I.canary_decoy_files (status)', 'canary_decoy_files_status_idx', v_schema_name);
    EXECUTE format('CREATE INDEX %I ON %I.tamper_alerts (server_id)', 'tamper_alerts_server_id_idx', v_schema_name);
    EXECUTE format('CREATE INDEX %I ON %I.tamper_alerts (detected_at)', 'tamper_alerts_detected_at_idx', v_schema_name);
    EXECUTE format('CREATE INDEX %I ON %I.tamper_alerts (severity)', 'tamper_alerts_severity_idx', v_schema_name);
    EXECUTE format('CREATE INDEX %I ON %I.tamper_alerts (severity, detected_at DESC)', 'tamper_alerts_severity_detected_at_idx', v_schema_name);
    EXECUTE format('CREATE INDEX %I ON %I.alert_mitigations (alert_id)', 'alert_mitigations_alert_id_idx', v_schema_name);
    EXECUTE format('CREATE INDEX %I ON %I.alert_mitigations (created_at DESC)', 'alert_mitigations_created_at_idx', v_schema_name);

    -- Registering Triggers
    EXECUTE format('CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON %I.users FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', v_schema_name);
    EXECUTE format('CREATE TRIGGER roles_touch_updated_at BEFORE UPDATE ON %I.roles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', v_schema_name);
    
    EXECUTE format('CREATE TRIGGER projects_touch_updated_at BEFORE UPDATE ON %I.projects FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', v_schema_name);
    EXECUTE format('CREATE TRIGGER servers_touch_updated_at BEFORE UPDATE ON %I.servers FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', v_schema_name);
    EXECUTE format('CREATE TRIGGER server_roles_touch_updated_at BEFORE UPDATE ON %I.server_roles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', v_schema_name);
    EXECUTE format('CREATE TRIGGER sentinel_agents_touch_updated_at BEFORE UPDATE ON %I.sentinel_agents FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', v_schema_name);
    EXECUTE format('CREATE TRIGGER canary_decoy_files_touch_updated_at BEFORE UPDATE ON %I.canary_decoy_files FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', v_schema_name);
    EXECUTE format('CREATE TRIGGER tamper_alerts_touch_updated_at BEFORE UPDATE ON %I.tamper_alerts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', v_schema_name);
    EXECUTE format('CREATE TRIGGER tamper_alerts_deny_update BEFORE UPDATE ON %I.tamper_alerts FOR EACH ROW EXECUTE FUNCTION public.deny_immutable_row_change()', v_schema_name);
    EXECUTE format('CREATE TRIGGER tamper_alerts_deny_delete BEFORE DELETE ON %I.tamper_alerts FOR EACH ROW EXECUTE FUNCTION public.deny_immutable_row_change()', v_schema_name);
    EXECUTE format('CREATE TRIGGER alert_mitigations_touch_updated_at BEFORE UPDATE ON %I.alert_mitigations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', v_schema_name);

    UPDATE public.tenants
    SET status = 'active'
    WHERE id = v_tenant_id;

    INSERT INTO public.global_audit_log (tenant_id, event_type, payload)
    VALUES (
        v_tenant_id,
        'CLIENT_PROVISION_SUCCESS',
        jsonb_build_object('schema_name', v_schema_name)
    );

    RETURN v_tenant_id;
END;
$$;
