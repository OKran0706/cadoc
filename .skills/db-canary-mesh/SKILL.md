---
name: db-canary-mesh
description: "Use this skill for database canary implementation. Covers: PostgreSQL and MySQL decoy table creation, canary row embedding in real tables, trigger-based access detection, pg_audit configuration, schema enumeration detection, query-pattern analysis, and sidecar log processor setup."
depends_on: sentinel-daemon/SKILL.md
---

# Database Canary Mesh

## Overview

The database canary mesh plants decoy assets at three levels inside relational databases:
1. **Canary schemas/tables** — entire fake tables with realistic names and data
2. **Canary rows** — individual fake rows embedded inside real application tables
3. **Query-level hooks** — triggers and audit extensions that fire on any access to canary assets

Any query that touches a canary table, reads a canary row, or performs suspicious schema enumeration is an immediate high-confidence signal.

---

## PostgreSQL Setup

### Install pg_audit

```bash
# Ubuntu/Debian
apt-get install postgresql-14-pgaudit

# Add to postgresql.conf
echo "shared_preload_libraries = 'pgaudit'" >> /etc/postgresql/14/main/postgresql.conf
systemctl restart postgresql
```

```sql
-- Enable auditing globally for canary schemas
ALTER SYSTEM SET pgaudit.log = 'read, write, ddl';
ALTER SYSTEM SET pgaudit.log_catalog = 'on';
SELECT pg_reload_conf();
```

### Canary Schema and Table Creation

```sql
-- /opt/canary/db/postgres/01-canary-schemas.sql
-- Run as superuser

-- Schema 1: Fake internal audit log (attractive to attackers)
CREATE SCHEMA IF NOT EXISTS _internal_audit;
COMMENT ON SCHEMA _internal_audit IS 'Internal audit system — read-only';

CREATE TABLE _internal_audit.access_log (
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

CREATE TABLE _financial_archive.transactions (
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

CREATE TABLE _system_config.secrets (
    key_name    TEXT PRIMARY KEY,
    key_value   TEXT,
    updated_at  TIMESTAMPTZ DEFAULT now(),
    updated_by  TEXT
);

INSERT INTO _system_config.secrets (key_name, key_value, updated_by) VALUES
    ('db_master_password',  'CANARY:' || encode(gen_random_bytes(32), 'hex'), 'svc-config'),
    ('api_signing_key',     'CANARY:' || encode(gen_random_bytes(32), 'hex'), 'svc-config'),
    ('stripe_secret_key',   'sk_live_CANARY' || encode(gen_random_bytes(16), 'hex'), 'svc-billing'),
    ('aws_secret_key',      'CANARY' || encode(gen_random_bytes(20), 'hex'), 'svc-infra');
```

### Row-Level Security — Deny All Legitimate Access

```sql
-- No application role should be able to read canary schemas
-- This makes any read an unambiguous anomaly

REVOKE ALL ON SCHEMA _internal_audit FROM PUBLIC;
REVOKE ALL ON SCHEMA _financial_archive FROM PUBLIC;
REVOKE ALL ON SCHEMA _system_config FROM PUBLIC;

REVOKE ALL ON ALL TABLES IN SCHEMA _internal_audit FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA _financial_archive FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA _system_config FROM PUBLIC;

-- Grant SELECT only to the canary monitor role (for seeding/verification)
GRANT USAGE ON SCHEMA _internal_audit TO canary_monitor;
GRANT SELECT ON ALL TABLES IN SCHEMA _internal_audit TO canary_monitor;
```

### Trigger-Based Access Detection

PostgreSQL `SELECT` does not fire row-level triggers. Instead, use the `RULE` system or a wrapper view with an `INSTEAD OF` trigger:

```sql
-- /opt/canary/db/postgres/02-canary-triggers.sql

-- Approach: create a view wrapping each canary table; access the view
-- The view fires a RULE that logs the access and raises an alert

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
    -- Write to a dedicated canary alert table (append-only via trigger)
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

    -- Also NOTIFY the canary listener process (async, non-blocking)
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

-- Trigger on any INSERT/UPDATE/DELETE to canary tables (SELECT via view rule)
CREATE OR REPLACE FUNCTION canary_dml_trigger() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM canary_access_alert(TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP);
    RETURN NULL;  -- Silently reject the write
END;
$$;

CREATE TRIGGER canary_audit_insert
    AFTER INSERT ON _system_config.secrets
    FOR EACH STATEMENT EXECUTE FUNCTION canary_dml_trigger();

CREATE TRIGGER canary_audit_delete
    AFTER DELETE ON _financial_archive.transactions
    FOR EACH STATEMENT EXECUTE FUNCTION canary_dml_trigger();

-- For SELECT detection: use event triggers on schema access
CREATE EVENT TRIGGER canary_ddl_watch
    ON ddl_command_start
    WHEN TAG IN ('SELECT', 'DROP TABLE', 'ALTER TABLE', 'DROP SCHEMA')
EXECUTE FUNCTION canary_ddl_trigger();
```

### Canary Rows in Real Tables

Embed canary rows inside real application tables. These are distinguishable only by the sentinel — not by the attacker:

```sql
-- /opt/canary/db/postgres/03-canary-rows.sql

-- Plant a canary user in the real users table
-- The ID format is designed to not look special
INSERT INTO users (id, email, name, created_at, metadata) VALUES
    ('usr_CANARY8f3a2d1e', 'svc-monitor@internal.invalid',
     'System Monitor',
     '2023-06-15 09:00:00+00',
     '{"role": "system", "__canary_id": "USERS_CANARY_001"}'::jsonb);

-- Create a monitoring function that alerts if this row is ever queried
-- Method: partition the users table into a real partition and a canary partition
-- Any query hitting the canary partition triggers pg_notify

-- Alternative: use a generated column with a logging side effect (PostgreSQL 12+)
-- This is less reliable but works without partitioning
```

### LISTEN/NOTIFY Canary Alert Consumer

The sentinel daemon runs a LISTEN consumer that receives real-time alerts from `pg_notify`:

```python
# /opt/sentinel/plugins/db_listener.py
import psycopg2
import select
import json

def listen_for_canary_alerts(conn_string: str, sentinel_client):
    conn = psycopg2.connect(conn_string)
    conn.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
    cur = conn.cursor()
    cur.execute("LISTEN canary_alert;")

    while True:
        if select.select([conn], [], [], 5) == ([], [], []):
            continue  # timeout, loop again
        conn.poll()
        while conn.notifies:
            notify = conn.notifies.pop(0)
            alert = json.loads(notify.payload)
            # Pass to sentinel for signing and shipping
            sentinel_client.emit_event({
                "type": "DB_CANARY_ACCESS",
                "source": "postgres_notify",
                **alert
            })
```

---

## Schema Enumeration Detection

Detect attackers exploring the database schema:

```sql
-- /opt/canary/db/postgres/04-enum-detection.sql

-- Log all information_schema and pg_catalog queries
-- Uses pg_audit's object auditing

SELECT pgaudit.set_config(
    'log', 'all',
    false  -- not superuser-only
);

-- Alternatively: create a dedicated function that counts catalog queries per role
-- and alerts when a threshold is crossed (implemented in the detection-engine)
```

The detection engine monitors the pg_audit log stream and scores for:

```
Enumeration heuristics:
- information_schema.tables queries: > 5 per minute from same role → MEDIUM alert
- pg_catalog.pg_class queries: > 20 per minute → MEDIUM alert
- Querying pg_description (schema comments): → LOW alert (recon signal)
- COPY TO queries: any → HIGH alert
- pg_dump pattern (sequence of sys catalog queries): → HIGH alert
```

---

## MySQL Setup

MySQL triggers do NOT fire on `SELECT`. Use the general query log targeted at canary tables instead:

```sql
-- /opt/canary/db/mysql/01-canary-tables.sql

-- Create canary database
CREATE DATABASE IF NOT EXISTS _internal_config;

CREATE TABLE _internal_config.api_keys (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    service     VARCHAR(64),
    key_value   VARCHAR(128),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes       TEXT
);

INSERT INTO _internal_config.api_keys (service, key_value, notes) VALUES
    ('payment-gateway', CONCAT('pk_live_CANARY', HEX(RANDOM_BYTES(16))), 'Production API key'),
    ('sendgrid',        CONCAT('SG.CANARY_', HEX(RANDOM_BYTES(16))), 'Email service key'),
    ('stripe',          CONCAT('sk_live_CANARY', HEX(RANDOM_BYTES(16))), 'Stripe secret key');
```

```bash
# Enable general log only for canary database
# Add to /etc/mysql/mysql.conf.d/mysqld.cnf

[mysqld]
general_log = 1
general_log_file = /var/log/mysql/general.log
# Note: this logs ALL queries — filter for canary in the sidecar
```

### MySQL Log Sidecar

```python
# /opt/canary/bin/mysql-log-watcher.py
# Tails MySQL general log and fires alerts on canary table access

import re
import tailer  # pip install tailer

CANARY_PATTERNS = [
    re.compile(r'_internal_config\.', re.IGNORECASE),
    re.compile(r'FROM\s+api_keys', re.IGNORECASE),
    re.compile(r'SHOW\s+DATABASES', re.IGNORECASE),
    re.compile(r'information_schema\.tables', re.IGNORECASE),
]

def watch_log(log_path: str, sentinel_client):
    for line in tailer.follow(open(log_path)):
        for pattern in CANARY_PATTERNS:
            if pattern.search(line):
                sentinel_client.emit_event({
                    "type": "DB_CANARY_ACCESS",
                    "source": "mysql_general_log",
                    "line": line.strip()
                })
                break
```

---

## canary_monitor Schema

Internal schema used by the sentinel to store and retrieve canary alerts from the database itself:

```sql
CREATE SCHEMA canary_monitor;

-- Append-only alerts table (trigger prevents DELETE and UPDATE)
CREATE TABLE canary_monitor.alerts (
    id          BIGSERIAL PRIMARY KEY,
    alert_time  TIMESTAMPTZ NOT NULL DEFAULT now(),
    alert_type  TEXT NOT NULL,
    db_user     TEXT,
    app_name    TEXT,
    client_addr TEXT,
    backend_pid INT,
    detail      JSONB
);

-- Prevent modification of existing alerts
CREATE OR REPLACE FUNCTION canary_monitor.deny_modification() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'canary_monitor.alerts is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_update BEFORE UPDATE ON canary_monitor.alerts
    FOR EACH ROW EXECUTE FUNCTION canary_monitor.deny_modification();

CREATE TRIGGER no_delete BEFORE DELETE ON canary_monitor.alerts
    FOR EACH ROW EXECUTE FUNCTION canary_monitor.deny_modification();
```

---

## Validation

```bash
# Test PostgreSQL canary trigger fires
psql -U attacker_test -c "SELECT * FROM _system_config.secrets LIMIT 1;"
# Expected: permission denied (role doesn't have access)
# BUT: the alert function fires before the permission check in some configurations
# Verify: check canary_monitor.alerts for the entry

# Test NOTIFY reaches listener
psql -U canary_monitor -c "SELECT canary_access_alert('_system_config.secrets', 'TEST');"
# Expected: listener receives notification within 1 second

# Test MySQL canary detection
mysql -u test_user -e "SELECT * FROM _internal_config.api_keys;" 2>/dev/null
sleep 2
grep "_internal_config" /var/log/canary/db.log | tail -1

# Test schema enumeration detection
for i in $(seq 1 25); do
  psql -U app_user -c "SELECT table_name FROM information_schema.tables;" > /dev/null
done
sleep 5
grep "SCHEMA_ENUM" /var/log/canary/sentinel.log | tail -1
```

---

## Dependencies

**Python 3.11+** — no language change; DB canary listener and MySQL watcher stay Python.

### Python Packages

```
psycopg2-binary==2.9.9
tailer==0.4.1
```

### Runtime Requirements

- PostgreSQL 14+ with `pg_audit` extension
- MySQL 8.0+ (general log sidecar approach)
- Sentinel daemon running and accepting events before DB listener starts

---

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `pg_notify` alerts not received | Listener connection dropped | Implement reconnect logic with exponential backoff |
| Trigger fires but no alert shipped | canary_monitor.alerts INSERT failing | Check sentinel DB user has INSERT on canary_monitor |
| False positive on schema migrations | Migration tool queries information_schema | Add migration service account to detection-engine exclusion list |
| MySQL general log too large | All queries logged | Rotate daily with `logrotate`; sidecar reads before rotation |
