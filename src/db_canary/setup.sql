-- canary-system/src/db_canary/setup.sql
-- Derived from: db-canary-mesh/SKILL.md — Full PostgreSQL canary mesh
-- Run as superuser on canarydb

-- ============================================================
-- 0. Load required extensions and schemas
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS canary_monitor;

CREATE TABLE IF NOT EXISTS canary_monitor.alerts (
    id          BIGSERIAL PRIMARY KEY,
    alert_time  TIMESTAMPTZ NOT NULL DEFAULT now(),
    alert_type  TEXT NOT NULL,
    db_user     TEXT,
    app_name    TEXT,
    client_addr TEXT,
    backend_pid INT,
    detail      JSONB
);

-- Prevent modification of existing alerts (append-only)
CREATE OR REPLACE FUNCTION canary_monitor.deny_modification() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'canary_monitor.alerts is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS no_update ON canary_monitor.alerts;
CREATE TRIGGER no_update BEFORE UPDATE ON canary_monitor.alerts
    FOR EACH ROW EXECUTE FUNCTION canary_monitor.deny_modification();

DROP TRIGGER IF EXISTS no_delete ON canary_monitor.alerts;
CREATE TRIGGER no_delete BEFORE DELETE ON canary_monitor.alerts
    FOR EACH ROW EXECUTE FUNCTION canary_monitor.deny_modification();

-- Response actions table
CREATE TABLE IF NOT EXISTS canary_monitor.response_actions (
    id          BIGSERIAL PRIMARY KEY,
    alert_id    TEXT,
    action_type TEXT,
    target      TEXT,
    detail      TEXT,
    executed_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 1. Canary schemas with realistic names and seed data
-- ============================================================

-- Schema 1: Fake internal audit log (attractive to attackers)
CREATE SCHEMA IF NOT EXISTS _internal_audit;
COMMENT ON SCHEMA _internal_audit IS 'Internal audit system — read-only';

CREATE TABLE IF NOT EXISTS _internal_audit.access_log (
    id          BIGSERIAL PRIMARY KEY,
    event_time  TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_name   TEXT,
    action      TEXT,
    resource    TEXT,
    ip_address  INET,
    session_id  UUID,
    details     JSONB
);

-- Seed with convincing fake data
INSERT INTO _internal_audit.access_log (event_time, user_name, action, resource, ip_address, session_id, details)
SELECT
    now() - (random() * interval '180 days'),
    (ARRAY['admin','alice','bob','svc-deploy','ci-runner'])[floor(random()*5+1)::int],
    (ARRAY['LOGIN','READ','WRITE','EXPORT','ADMIN_ACTION'])[floor(random()*5+1)::int],
    (ARRAY['user_data','payments','config','secrets','reports'])[floor(random()*5+1)::int],
    ('10.0.' || floor(random()*255)::text || '.' || floor(random()*255)::text)::inet,
    gen_random_uuid(),
    jsonb_build_object('status', 'success', 'duration_ms', floor(random()*500))
FROM generate_series(1, 5000);


-- Schema 2: Fake financial archive (high-value lure)
CREATE SCHEMA IF NOT EXISTS _financial_archive;

CREATE TABLE IF NOT EXISTS _financial_archive.transactions (
    txn_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at  TIMESTAMPTZ DEFAULT now(),
    amount      NUMERIC(12,2),
    currency    CHAR(3),
    from_acct   TEXT,
    to_acct     TEXT,
    status      TEXT,
    metadata    JSONB
);

INSERT INTO _financial_archive.transactions (amount, currency, from_acct, to_acct, status)
SELECT
    round((random() * 100000)::numeric, 2),
    (ARRAY['USD','EUR','GBP','JPY'])[floor(random()*4+1)::int],
    'ACC-' || lpad(floor(random()*999999)::text, 9, '0'),
    'ACC-' || lpad(floor(random()*999999)::text, 9, '0'),
    (ARRAY['completed','pending','failed'])[floor(random()*3+1)::int]
FROM generate_series(1, 10000);


-- Schema 3: Fake system config (credential lure)
CREATE SCHEMA IF NOT EXISTS _system_config;

CREATE TABLE IF NOT EXISTS _system_config.secrets (
    key_name    TEXT PRIMARY KEY,
    key_value   TEXT,
    updated_at  TIMESTAMPTZ DEFAULT now(),
    updated_by  TEXT
);

INSERT INTO _system_config.secrets (key_name, key_value, updated_by) VALUES
    ('db_master_password',  'CANARY:' || encode(gen_random_bytes(32), 'hex'), 'svc-config'),
    ('api_signing_key',     'CANARY:' || encode(gen_random_bytes(32), 'hex'), 'svc-config'),
    ('stripe_secret_key',   'sk_live_CANARY' || encode(gen_random_bytes(16), 'hex'), 'svc-billing'),
    ('aws_secret_key',      'CANARY' || encode(gen_random_bytes(20), 'hex'), 'svc-infra')
ON CONFLICT (key_name) DO NOTHING;


-- ============================================================
-- 2. Row-level security — deny all legitimate access
-- ============================================================
REVOKE ALL ON SCHEMA _internal_audit FROM PUBLIC;
REVOKE ALL ON SCHEMA _financial_archive FROM PUBLIC;
REVOKE ALL ON SCHEMA _system_config FROM PUBLIC;

REVOKE ALL ON ALL TABLES IN SCHEMA _internal_audit FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA _financial_archive FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA _system_config FROM PUBLIC;

-- Grant to canary_monitor role only
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'canary_monitor') THEN
        CREATE ROLE canary_monitor LOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA canary_monitor TO canary_monitor;
GRANT INSERT ON canary_monitor.alerts TO canary_monitor;
GRANT SELECT ON canary_monitor.alerts TO canary_monitor;
GRANT USAGE, SELECT ON SEQUENCE canary_monitor.alerts_id_seq TO canary_monitor;

GRANT USAGE ON SCHEMA _internal_audit TO canary_monitor;
GRANT SELECT ON ALL TABLES IN SCHEMA _internal_audit TO canary_monitor;


-- ============================================================
-- 3. Trigger-based access detection
-- ============================================================

CREATE OR REPLACE FUNCTION canary_access_alert(
    table_name TEXT,
    operation  TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_user TEXT := session_user;
    v_app  TEXT := current_setting('application_name', true);
    v_addr TEXT := inet_client_addr()::text;
    v_pid  INT  := pg_backend_pid();
BEGIN
    -- Write to canary alert table
    INSERT INTO canary_monitor.alerts (
        alert_time, alert_type, db_user, app_name, client_addr, backend_pid, detail
    ) VALUES (
        now(), 'DB_CANARY_ACCESS', v_user, v_app, v_addr, v_pid,
        jsonb_build_object(
            'table', table_name,
            'operation', operation,
            'query', current_query()
        )
    );

    -- NOTIFY the canary listener process
    PERFORM pg_notify('canary_alert',
        json_build_object(
            'type', 'DB_CANARY_ACCESS',
            'table', table_name,
            'user', v_user,
            'addr', v_addr,
            'pid', v_pid,
            'ts', extract(epoch from now())
        )::text
    );
END;
$$;

-- DML trigger function
CREATE OR REPLACE FUNCTION canary_dml_trigger() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM canary_access_alert(TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP);
    RETURN NULL;  -- Silently reject the write
END;
$$;

-- Triggers on canary tables
DROP TRIGGER IF EXISTS canary_audit_insert ON _system_config.secrets;
CREATE TRIGGER canary_audit_insert
    AFTER INSERT ON _system_config.secrets
    FOR EACH STATEMENT EXECUTE FUNCTION canary_dml_trigger();

DROP TRIGGER IF EXISTS canary_audit_delete ON _financial_archive.transactions;
CREATE TRIGGER canary_audit_delete
    AFTER DELETE ON _financial_archive.transactions
    FOR EACH STATEMENT EXECUTE FUNCTION canary_dml_trigger();

-- DDL event trigger for schema access detection
CREATE OR REPLACE FUNCTION canary_ddl_trigger_func()
RETURNS event_trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM canary_access_alert('DDL_EVENT', tg_tag);
END;
$$;

-- Note: event triggers only fire on DDL commands, not SELECT
-- SELECT detection uses pg_audit or the NOTIFY mechanism
DROP EVENT TRIGGER IF EXISTS canary_ddl_watch;
CREATE EVENT TRIGGER canary_ddl_watch
    ON ddl_command_start
    WHEN TAG IN ('DROP TABLE', 'ALTER TABLE', 'DROP SCHEMA')
    EXECUTE FUNCTION canary_ddl_trigger_func();


-- ============================================================
-- 4. Schema enumeration detection (pg_audit config)
-- ============================================================
-- Note: requires pgaudit extension to be loaded
-- ALTER SYSTEM SET pgaudit.log = 'read, write, ddl';
-- ALTER SYSTEM SET pgaudit.log_catalog = 'on';
-- SELECT pg_reload_conf();
