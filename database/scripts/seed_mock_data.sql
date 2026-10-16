\set ON_ERROR_STOP on

\if :{?tenant_slug}
\else
    \set tenant_slug 'mock-acme'
\endif

\if :{?tenant_name}
\else
    \set tenant_name 'Mock Acme Corporation'
\endif

CREATE TEMP TABLE mock_seed_config AS
SELECT :'tenant_slug'::text AS tenant_slug,
       :'tenant_name'::text AS tenant_name;

DO $$
DECLARE
    v_slug TEXT;
    v_name TEXT;
    v_schema_name TEXT;
    v_tenant_id UUID;
BEGIN
    SELECT tenant_slug, tenant_name
    INTO v_slug, v_name
    FROM mock_seed_config;

    IF v_slug !~ '^mock-[a-z0-9][a-z0-9-]*$' THEN
        RAISE EXCEPTION 'Mock seed tenant slug "%" must start with "mock-"', v_slug;
    END IF;

    SELECT id, 'client_' || slug
    INTO v_tenant_id, v_schema_name
    FROM public.tenants
    WHERE slug = v_slug;

    IF v_tenant_id IS NOT NULL THEN
        EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', v_schema_name);

        DELETE FROM public.global_audit_log
        WHERE tenant_id = v_tenant_id;

        DELETE FROM public.tenants
        WHERE id = v_tenant_id;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.tenants
        WHERE slug = v_slug
    ) THEN
        PERFORM public.provision_tenant(v_slug, v_name);
    ELSIF EXISTS (
        SELECT 1
        FROM public.tenants
        WHERE slug = v_slug
          AND status <> 'active'
    ) THEN
        RAISE EXCEPTION 'Tenant "%" exists but is not active', v_slug;
    END IF;
END;
$$;

SELECT public.set_tenant_search_path(:'tenant_slug', false) AS active_schema;

INSERT INTO public.global_audit_log (tenant_id, event_type, payload)
SELECT
    id,
    'MOCK_DATA_SEED',
    jsonb_build_object(
        'source', 'database/scripts/seed_mock_data.sql',
        'tenant_slug', :'tenant_slug'
    )
FROM public.tenants
WHERE slug = :'tenant_slug';

-- ---------------------------------------------------------------------------
-- RBAC: Roles (permission-based, used by users in this tenant's schema)
-- These are authorization roles, not infrastructure server tags.
-- ---------------------------------------------------------------------------

INSERT INTO roles (name, permissions)
VALUES
    ('tenant-admin',   '["project.manage", "server.manage", "security.read", "security.respond", "project.read", "server.read"]'::jsonb),
    ('security-analyst', '["security.read", "security.respond", "server.read", "project.read"]'::jsonb),
    ('read-only',      '["project.read", "server.read", "security.read"]'::jsonb)
ON CONFLICT (name) DO UPDATE
SET permissions = EXCLUDED.permissions;

-- ---------------------------------------------------------------------------
-- Users (local tenant users, hashed with bcrypt placeholder)
-- ---------------------------------------------------------------------------
-- NOTE: password_hash below is a bcrypt hash of "MockPass123!!" for dev only.
-- Replace with a real hash via the admin API before any staging use.

INSERT INTO users (email, display_name, password_hash)
VALUES
    ('alice@mock-acme.example', 'Alice Admin',    '$2b$12$/gTNls8RmuMw1Sa1yh5zgOL0EA3MLlccC6SbqLz/JvI1tg3.TwLga'),
    ('alice@mock-acme.com',     'Alice Admin',    '$2b$12$/gTNls8RmuMw1Sa1yh5zgOL0EA3MLlccC6SbqLz/JvI1tg3.TwLga'),
    ('bob@mock-acme.example',   'Bob Analyst',    '$2b$12$/gTNls8RmuMw1Sa1yh5zgOL0EA3MLlccC6SbqLz/JvI1tg3.TwLga'),
    ('bob@mock-acme.com',       'Bob Analyst',    '$2b$12$/gTNls8RmuMw1Sa1yh5zgOL0EA3MLlccC6SbqLz/JvI1tg3.TwLga'),
    ('carol@mock-acme.example', 'Carol Readonly', '$2b$12$/gTNls8RmuMw1Sa1yh5zgOL0EA3MLlccC6SbqLz/JvI1tg3.TwLga'),
    ('carol@mock-acme.com',     'Carol Readonly', '$2b$12$/gTNls8RmuMw1Sa1yh5zgOL0EA3MLlccC6SbqLz/JvI1tg3.TwLga')
ON CONFLICT (email) DO UPDATE
SET display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash;

-- Assign roles to users
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r ON (
    (u.email LIKE 'alice@mock-acme%' AND r.name = 'tenant-admin')
    OR (u.email LIKE 'bob@mock-acme%'   AND r.name = 'security-analyst')
    OR (u.email LIKE 'carol@mock-acme%' AND r.name = 'read-only')
)
ON CONFLICT (user_id, role_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------

INSERT INTO projects (name, description)
VALUES
    ('Mock Payments Platform',   'Mock project for payment-facing infrastructure.'),
    ('Mock Internal Operations', 'Mock project for back-office systems.')
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description;

-- ---------------------------------------------------------------------------
-- Servers (linked to projects)
-- ---------------------------------------------------------------------------

WITH project_rows AS (
    SELECT id, name
    FROM projects
    WHERE name IN ('Mock Payments Platform', 'Mock Internal Operations')
)
INSERT INTO servers (project_id, hostname, ip_address, status, specs)
SELECT
    project_rows.id,
    seed.hostname,
    seed.ip_address::inet,
    seed.status,
    seed.specs::jsonb
FROM (
    VALUES
        (
            'Mock Payments Platform',
            'mock-pay-web-01.internal',
            '10.42.10.11',
            'online',
            '{"cpu": "8 vCPU", "ram_gb": 32, "os": "Ubuntu 22.04", "disk": "250GB gp3"}'
        ),
        (
            'Mock Payments Platform',
            'mock-pay-db-01.internal',
            '10.42.10.21',
            'maintenance',
            '{"cpu": "16 vCPU", "ram_gb": 64, "os": "Ubuntu 22.04", "disk": "1TB io2"}'
        ),
        (
            'Mock Internal Operations',
            'mock-ops-worker-01.internal',
            '10.42.20.31',
            'offline',
            '{"cpu": "4 vCPU", "ram_gb": 16, "os": "Debian 12", "disk": "120GB gp3"}'
        )
) AS seed(project_name, hostname, ip_address, status, specs)
JOIN project_rows ON project_rows.name = seed.project_name
ON CONFLICT (hostname) DO UPDATE
SET
    project_id = EXCLUDED.project_id,
    ip_address = EXCLUDED.ip_address,
    status     = EXCLUDED.status,
    specs      = EXCLUDED.specs;

-- ---------------------------------------------------------------------------
-- Sentinel Agents
-- ---------------------------------------------------------------------------

INSERT INTO sentinel_agents (
    server_id,
    version,
    git_commit,
    status,
    capabilities_proof,
    last_connected_at
)
SELECT
    s.id,
    seed.version,
    seed.git_commit,
    seed.status,
    seed.capabilities_proof::jsonb,
    seed.last_connected_at
FROM (
    VALUES
        (
            'mock-pay-web-01.internal',
            'v1.6.2',
            '1111111111111111111111111111111111111111',
            'active',
            '{"caps": ["CAP_AUDIT_READ"], "auditd": true, "kernel_lockdown": "integrity"}',
            now() - interval '2 minutes'
        ),
        (
            'mock-pay-db-01.internal',
            'v1.6.1',
            '2222222222222222222222222222222222222222',
            'degraded',
            '{"caps": ["CAP_AUDIT_READ"], "auditd": true, "kernel_lockdown": "none"}',
            now() - interval '18 minutes'
        ),
        (
            'mock-ops-worker-01.internal',
            'v1.5.9',
            '3333333333333333333333333333333333333333',
            'offline',
            '{"caps": [], "auditd": false, "kernel_lockdown": "unknown"}',
            now() - interval '3 hours'
        )
) AS seed(hostname, version, git_commit, status, capabilities_proof, last_connected_at)
JOIN servers s ON s.hostname = seed.hostname;

-- ---------------------------------------------------------------------------
-- Canary Decoy Files
-- ---------------------------------------------------------------------------

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
    s.id,
    seed.file_path,
    seed.decoy_type,
    seed.original_hash,
    seed.status,
    seed.planted_at,
    seed.last_verified
FROM (
    VALUES
        (
            'mock-pay-web-01.internal',
            '/home/admin/.aws/credentials',
            'AWS_CREDS',
            repeat('a', 64),
            'planted',
            now() - interval '5 days',
            now() - interval '4 minutes'
        ),
        (
            'mock-pay-db-01.internal',
            '/etc/app/database.yml',
            'DB_CONFIG',
            repeat('b', 64),
            'tampered',
            now() - interval '4 days',
            now() - interval '17 minutes'
        ),
        (
            'mock-ops-worker-01.internal',
            '/home/deploy/.ssh/id_rsa',
            'SSH_KEY',
            repeat('c', 64),
            'verification_failed',
            now() - interval '2 days',
            now() - interval '3 hours'
        )
) AS seed(hostname, file_path, decoy_type, original_hash, status, planted_at, last_verified)
JOIN servers s ON s.hostname = seed.hostname;

-- ---------------------------------------------------------------------------
-- Tamper Alerts
-- ---------------------------------------------------------------------------

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
    seed.event_type,
    seed.severity,
    jsonb_build_object(
        'pid',          seed.pid,
        'uid',          seed.uid,
        'auid',         seed.auid,
        'exe',          seed.exe,
        'syscall',      seed.syscall,
        'decoy_file_id', d.id,
        'mock',         true
    ),
    seed.detected_at
FROM (
    VALUES
        (
            'mock-pay-db-01.internal',
            '/etc/app/database.yml',
            'DECOY_TAMPER',
            'critical',
            4312,
            1000,
            1000,
            '/usr/bin/vim',
            'openat',
            now() - interval '12 minutes'
        ),
        (
            'mock-pay-web-01.internal',
            '/home/admin/.aws/credentials',
            'AUDITD_RULE_DELETED',
            'high',
            7821,
            0,
            1001,
            '/usr/sbin/auditctl',
            'delete_rule',
            now() - interval '45 minutes'
        ),
        (
            'mock-ops-worker-01.internal',
            '/home/deploy/.ssh/id_rsa',
            'SYSTEM_INTEGRITY_FAIL',
            'medium',
            9144,
            1002,
            1002,
            '/usr/bin/python3',
            'chmod',
            now() - interval '2 hours'
        )
) AS seed(
    hostname,
    file_path,
    event_type,
    severity,
    pid,
    uid,
    auid,
    exe,
    syscall,
    detected_at
)
JOIN servers s ON s.hostname = seed.hostname
LEFT JOIN sentinel_agents a ON a.server_id = s.id
LEFT JOIN canary_decoy_files d ON d.server_id = s.id AND d.file_path = seed.file_path;

-- ---------------------------------------------------------------------------
-- Alert Mitigations (one sample resolved alert for the critical tamper)
-- ---------------------------------------------------------------------------

INSERT INTO alert_mitigations (alert_id, analyst_user_id, mitigation_notes)
SELECT
    ta.id,
    u.id,
    'Mock mitigation: decoy file restored and auditd rules reapplied. Attacker IP blocked at perimeter firewall.'
FROM tamper_alerts ta
JOIN servers s ON s.id = ta.server_id AND s.hostname = 'mock-pay-db-01.internal'
JOIN users u ON u.email = 'bob@mock-acme.example'
WHERE ta.event_type = 'DECOY_TAMPER'
  AND ta.severity = 'critical'
LIMIT 1
ON CONFLICT (alert_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Summary
-- ---------------------------------------------------------------------------

SELECT
    :'tenant_slug' AS tenant_slug,
    (SELECT count(*) FROM public.tenants WHERE slug = :'tenant_slug')                                                                      AS tenants,
    (SELECT count(*) FROM public.global_audit_log gal JOIN public.tenants t ON t.id = gal.tenant_id WHERE t.slug = :'tenant_slug')         AS audit_events,
    (SELECT count(*) FROM projects      WHERE name  LIKE 'Mock %')                                                                         AS projects,
    (SELECT count(*) FROM servers       WHERE hostname LIKE 'mock-%')                                                                      AS servers,
    (SELECT count(*) FROM users         WHERE email LIKE '%@mock-acme%')                                                                   AS users,
    (SELECT count(*) FROM roles         WHERE name IN ('tenant-admin', 'security-analyst', 'read-only'))                                   AS rbac_roles,
    (SELECT count(*) FROM user_roles    ur JOIN users u ON u.id = ur.user_id WHERE u.email LIKE '%@mock-acme%')                            AS user_role_assignments,
    (SELECT count(*) FROM sentinel_agents a  JOIN servers s ON s.id = a.server_id WHERE s.hostname LIKE 'mock-%')                          AS sentinel_agents,
    (SELECT count(*) FROM canary_decoy_files d JOIN servers s ON s.id = d.server_id WHERE s.hostname LIKE 'mock-%')                        AS canary_decoy_files,
    (SELECT count(*) FROM tamper_alerts ta   JOIN servers s ON s.id = ta.server_id WHERE s.hostname LIKE 'mock-%')                         AS tamper_alerts,
    (SELECT count(*) FROM alert_mitigations am JOIN tamper_alerts ta ON ta.id = am.alert_id JOIN servers s ON s.id = ta.server_id WHERE s.hostname LIKE 'mock-%') AS alert_mitigations;

DROP TABLE mock_seed_config;
