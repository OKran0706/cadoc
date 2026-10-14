\set ON_ERROR_STOP on

SELECT public.provision_tenant('acme-corp', 'Acme Corporation') AS tenant_id;

DO $$
DECLARE
    v_schema TEXT := 'client_acme-corp';
    v_table_count INT;
    v_index_count INT;
    v_trigger_count INT;
    v_partition_count INT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'global_audit_log'
          AND c.relkind = 'p'
    ) THEN
        RAISE EXCEPTION 'global_audit_log is not partitioned';
    END IF;

    SELECT count(*)
    INTO v_partition_count
    FROM pg_inherits i
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE parent_ns.nspname = 'public'
      AND parent.relname = 'global_audit_log';

    IF v_partition_count < 3 THEN
        RAISE EXCEPTION 'Expected at least 3 global audit partitions, found %', v_partition_count;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.tenants
        WHERE slug = 'acme-corp'
          AND status = 'active'
    ) THEN
        RAISE EXCEPTION 'Tenant was not activated';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_namespace
        WHERE nspname = v_schema
    ) THEN
        RAISE EXCEPTION 'Tenant schema was not created';
    END IF;

    SELECT count(*)
    INTO v_table_count
    FROM information_schema.tables
    WHERE table_schema = v_schema
      AND table_name IN (
          'projects',
          'servers',
          'roles',
          'server_roles',
          'sentinel_agents',
          'canary_decoy_files',
          'tamper_alerts'
      );

    IF v_table_count <> 7 THEN
        RAISE EXCEPTION 'Expected 7 tenant tables, found %', v_table_count;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = v_schema
          AND c.relname = 'tamper_alerts'
          AND c.relkind = 'p'
    ) THEN
        RAISE EXCEPTION 'tamper_alerts is not partitioned';
    END IF;

    SELECT count(*)
    INTO v_partition_count
    FROM pg_inherits i
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE parent_ns.nspname = v_schema
      AND parent.relname = 'tamper_alerts';

    IF v_partition_count < 3 THEN
        RAISE EXCEPTION 'Expected at least 3 tamper alert partitions, found %', v_partition_count;
    END IF;

    SELECT count(*)
    INTO v_index_count
    FROM pg_indexes
    WHERE schemaname = v_schema
      AND indexname IN (
          'sentinel_agents_last_heartbeat_idx',
          'canary_decoy_files_status_idx',
          'tamper_alerts_detected_at_idx',
          'tamper_alerts_severity_idx',
          'tamper_alerts_severity_detected_at_idx'
      );

    IF v_index_count <> 5 THEN
        RAISE EXCEPTION 'Expected 5 telemetry indexes, found %', v_index_count;
    END IF;

    SELECT count(*)
    INTO v_trigger_count
    FROM information_schema.triggers
    WHERE trigger_schema = v_schema
      AND event_object_table IN (
          'projects',
          'servers',
          'roles',
          'server_roles',
          'sentinel_agents',
          'canary_decoy_files',
          'tamper_alerts'
      );

    IF v_trigger_count < 7 THEN
        RAISE EXCEPTION 'Expected updated_at triggers on tenant tables, found %', v_trigger_count;
    END IF;
END;
$$;

SELECT public.set_tenant_search_path('acme-corp', false) AS active_schema;

INSERT INTO projects (name, description)
VALUES ('CMDB', 'Smoke test project');

INSERT INTO servers (project_id, hostname, ip_address, status, specs)
SELECT id, 'web-01.acme.local', '10.10.0.5', 'online', '{"cpu": "4", "ram_gb": 16}'::jsonb
FROM projects
WHERE name = 'CMDB';

INSERT INTO roles (name, permissions)
VALUES ('web-server', '{"deploy": true}'::jsonb);

INSERT INTO server_roles (server_id, role_id)
SELECT s.id, r.id
FROM servers s
CROSS JOIN roles r
WHERE s.hostname = 'web-01.acme.local'
  AND r.name = 'web-server';

INSERT INTO sentinel_agents (
    server_id,
    version,
    git_commit,
    status,
    capabilities_proof,
    last_heartbeat
)
SELECT
    id,
    'v1.6.2',
    '0123456789abcdef0123456789abcdef01234567',
    'active',
    '{"caps": ["CAP_AUDIT_READ"]}'::jsonb,
    now()
FROM servers
WHERE hostname = 'web-01.acme.local';

INSERT INTO canary_decoy_files (
    server_id,
    file_path,
    decoy_type,
    original_hash,
    status,
    planted_at,
    last_verified
)
SELECT
    id,
    '/home/admin/.aws/credentials',
    'AWS_CREDS',
    repeat('a', 64),
    'planted',
    now(),
    now()
FROM servers
WHERE hostname = 'web-01.acme.local';

INSERT INTO tamper_alerts (
    server_id,
    agent_id,
    event_type,
    severity,
    details,
    detected_at
)
SELECT
    s.id,
    a.id,
    'DECOY_TAMPER',
    'critical',
    jsonb_build_object(
        'pid', 1234,
        'uid', 1000,
        'auid', 1000,
        'exe', '/usr/bin/cat',
        'syscall', 'openat',
        'decoy_file_id', d.id
    ),
    now()
FROM servers s
JOIN sentinel_agents a ON a.server_id = s.id
JOIN canary_decoy_files d ON d.server_id = s.id
WHERE s.hostname = 'web-01.acme.local';

DO $$
BEGIN
    UPDATE tamper_alerts SET severity = 'low';
    RAISE EXCEPTION 'tamper_alerts update unexpectedly succeeded';
EXCEPTION
    WHEN SQLSTATE '55000' THEN
        NULL;
END;
$$;

DO $$
BEGIN
    PERFORM public.provision_tenant('acme-corp', 'Duplicate Acme');
    RAISE EXCEPTION 'Duplicate slug unexpectedly succeeded';
EXCEPTION
    WHEN unique_violation THEN
        NULL;
END;
$$;

DO $$
BEGIN
    PERFORM public.provision_tenant('Bad_Slug', 'Bad Slug');
    RAISE EXCEPTION 'Invalid slug unexpectedly succeeded';
EXCEPTION
    WHEN invalid_parameter_value THEN
        NULL;
END;
$$;

CREATE SCHEMA "client_preexisting";

DO $$
BEGIN
    PERFORM public.provision_tenant('preexisting', 'Pre Existing');
    RAISE EXCEPTION 'Pre-existing schema failure unexpectedly succeeded';
EXCEPTION
    WHEN duplicate_schema THEN
        IF EXISTS (SELECT 1 FROM public.tenants WHERE slug = 'preexisting') THEN
            RAISE EXCEPTION 'Failed provisioning left an orphan tenant row';
        END IF;
END;
$$;

DROP SCHEMA "client_preexisting";

SELECT
    (SELECT count(*) FROM public.tenants) AS tenant_count,
    (SELECT count(*) FROM public.global_audit_log) AS audit_count,
    (SELECT count(*) FROM projects) AS project_count,
    (SELECT count(*) FROM servers) AS server_count,
    (SELECT count(*) FROM sentinel_agents) AS agent_count,
    (SELECT count(*) FROM canary_decoy_files) AS decoy_count,
    (SELECT count(*) FROM tamper_alerts) AS alert_count;
