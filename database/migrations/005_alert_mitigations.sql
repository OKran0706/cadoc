-- Migration 005: Create alert_mitigations table for administrative mitigations

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
            CONSTRAINT servers_status_chk CHECK (
                status IN ('online', 'offline', 'maintenance')
            )
        )
    $ddl$, v_schema_name, v_schema_name);

    EXECUTE format($ddl$
        CREATE TABLE %I.roles (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(50) NOT NULL UNIQUE,
            permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    $ddl$, v_schema_name);

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
            CONSTRAINT sentinel_agents_status_chk CHECK (
                status IN ('active', 'offline', 'degraded')
            )
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
            CONSTRAINT canary_decoy_files_hash_chk CHECK (
                original_hash ~ '^[A-Fa-f0-9]{64}$'
            ),
            CONSTRAINT canary_decoy_files_status_chk CHECK (
                status IN ('planted', 'tampered', 'cleaned_up', 'verification_failed')
            )
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
            CONSTRAINT tamper_alerts_event_type_chk CHECK (
                event_type IN (
                    'DECOY_TAMPER',
                    'BINARY_TAMPER',
                    'AUDITD_RULE_DELETED',
                    'SYSTEM_INTEGRITY_FAIL'
                )
            ),
            CONSTRAINT tamper_alerts_severity_chk CHECK (
                severity IN ('low', 'medium', 'high', 'critical')
            )
        ) PARTITION BY RANGE (detected_at)
    $ddl$, v_schema_name, v_schema_name, v_schema_name);

    PERFORM public.ensure_monthly_range_partition(v_schema_name, 'tamper_alerts', now());
    PERFORM public.ensure_monthly_range_partition(v_schema_name, 'tamper_alerts', now() + interval '1 month');

    EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %I.tamper_alerts DEFAULT',
        v_schema_name,
        'tamper_alerts_default',
        v_schema_name
    );

    -- New alert_mitigations table
    EXECUTE format($ddl$
        CREATE TABLE %I.alert_mitigations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            alert_id UUID NOT NULL UNIQUE,
            analyst_user_id UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
            mitigation_notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    $ddl$, v_schema_name);

    EXECUTE format(
        'CREATE INDEX %I ON %I.servers (project_id)',
        'servers_project_id_idx',
        v_schema_name
    );
    EXECUTE format(
        'CREATE INDEX %I ON %I.server_roles (role_id)',
        'server_roles_role_id_idx',
        v_schema_name
    );
    EXECUTE format(
        'CREATE INDEX %I ON %I.sentinel_agents (server_id)',
        'sentinel_agents_server_id_idx',
        v_schema_name
    );
    EXECUTE format(
        'CREATE INDEX %I ON %I.sentinel_agents (last_connected_at)',
        'sentinel_agents_last_connected_at_idx',
        v_schema_name
    );
    EXECUTE format(
        'CREATE INDEX %I ON %I.canary_decoy_files (server_id)',
        'canary_decoy_files_server_id_idx',
        v_schema_name
    );
    EXECUTE format(
        'CREATE INDEX %I ON %I.canary_decoy_files (status)',
        'canary_decoy_files_status_idx',
        v_schema_name
    );
    EXECUTE format(
        'CREATE INDEX %I ON %I.tamper_alerts (server_id)',
        'tamper_alerts_server_id_idx',
        v_schema_name
    );
    EXECUTE format(
        'CREATE INDEX %I ON %I.tamper_alerts (detected_at)',
        'tamper_alerts_detected_at_idx',
        v_schema_name
    );
    EXECUTE format(
        'CREATE INDEX %I ON %I.tamper_alerts (severity)',
        'tamper_alerts_severity_idx',
        v_schema_name
    );
    EXECUTE format(
        'CREATE INDEX %I ON %I.tamper_alerts (severity, detected_at DESC)',
        'tamper_alerts_severity_detected_at_idx',
        v_schema_name
    );
    -- New alert_mitigations indexes
    EXECUTE format(
        'CREATE INDEX %I ON %I.alert_mitigations (alert_id)',
        'alert_mitigations_alert_id_idx',
        v_schema_name
    );
    EXECUTE format(
        'CREATE INDEX %I ON %I.alert_mitigations (created_at DESC)',
        'alert_mitigations_created_at_idx',
        v_schema_name
    );

    EXECUTE format(
        'CREATE TRIGGER projects_touch_updated_at BEFORE UPDATE ON %I.projects FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
        v_schema_name
    );
    EXECUTE format(
        'CREATE TRIGGER servers_touch_updated_at BEFORE UPDATE ON %I.servers FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
        v_schema_name
    );
    EXECUTE format(
        'CREATE TRIGGER roles_touch_updated_at BEFORE UPDATE ON %I.roles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
        v_schema_name
    );
    EXECUTE format(
        'CREATE TRIGGER server_roles_touch_updated_at BEFORE UPDATE ON %I.server_roles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
        v_schema_name
    );
    EXECUTE format(
        'CREATE TRIGGER sentinel_agents_touch_updated_at BEFORE UPDATE ON %I.sentinel_agents FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
        v_schema_name
    );
    EXECUTE format(
        'CREATE TRIGGER canary_decoy_files_touch_updated_at BEFORE UPDATE ON %I.canary_decoy_files FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
        v_schema_name
    );
    EXECUTE format(
        'CREATE TRIGGER tamper_alerts_touch_updated_at BEFORE UPDATE ON %I.tamper_alerts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
        v_schema_name
    );
    EXECUTE format(
        'CREATE TRIGGER tamper_alerts_deny_update BEFORE UPDATE ON %I.tamper_alerts FOR EACH ROW EXECUTE FUNCTION public.deny_immutable_row_change()',
        v_schema_name
    );
    EXECUTE format(
        'CREATE TRIGGER tamper_alerts_deny_delete BEFORE DELETE ON %I.tamper_alerts FOR EACH ROW EXECUTE FUNCTION public.deny_immutable_row_change()',
        v_schema_name
    );
    -- New alert_mitigations triggers
    EXECUTE format(
        'CREATE TRIGGER alert_mitigations_touch_updated_at BEFORE UPDATE ON %I.alert_mitigations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
        v_schema_name
    );

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


-- Migrate all existing client schemas dynamically
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
                analyst_user_id UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
                mitigation_notes TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        $ddl$, r.schema_name);

        EXECUTE format($ddl$
            CREATE INDEX IF NOT EXISTS alert_mitigations_alert_id_idx ON %I.alert_mitigations (alert_id)
        $ddl$, r.schema_name);

        EXECUTE format($ddl$
            CREATE INDEX IF NOT EXISTS alert_mitigations_created_at_idx ON %I.alert_mitigations (created_at DESC)
        $ddl$, r.schema_name);

        EXECUTE format($ddl$
            DROP TRIGGER IF EXISTS alert_mitigations_touch_updated_at ON %I.alert_mitigations
        $ddl$, r.schema_name);

        EXECUTE format($ddl$
            CREATE TRIGGER alert_mitigations_touch_updated_at 
            BEFORE UPDATE ON %I.alert_mitigations 
            FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()
        $ddl$, r.schema_name);
    END LOOP;
END;
$$;
