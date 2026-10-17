import pytest

from app.services.forensics.guard import GuardError, guard_sql as _guard

PID = "11111111-2222-3333-4444-555555555555"


def guard_sql(sql, **kw):
    return _guard(sql, PID, **kw)


OK = [
    "SELECT * FROM tamper_alerts WHERE detected_at > now() - interval '7 days'",
    "SELECT severity, count(*) FROM tamper_alerts WHERE detected_at >= now() - interval '1 day' GROUP BY severity",
    "SELECT hostname FROM servers",
    "WITH a AS (SELECT server_id FROM tamper_alerts WHERE detected_at > now() - interval '1 day') "
    "SELECT s.hostname FROM a JOIN servers s ON s.id = a.server_id",
    "SELECT date_trunc('hour', detected_at) h, count(*) FROM tamper_alerts "
    "WHERE detected_at > now() - interval '1 day' GROUP BY 1 ORDER BY 1",
    "SELECT details->>'cmdline' FROM tamper_alerts WHERE detected_at > now() - interval '1 day' AND lower(op) = 'write'",
    "SELECT 1 FROM tamper_alerts WHERE detected_at > now() - interval '1 day';",
]

BAD = {
    "multi_statement": "SELECT 1 FROM servers; SELECT 2 FROM servers",
    "insert": "INSERT INTO servers(hostname) VALUES ('x')",
    "update": "UPDATE servers SET hostname='x'",
    "delete": "DELETE FROM servers",
    "drop": "DROP TABLE servers",
    "create": "CREATE TABLE t AS SELECT * FROM servers",
    "set": "SET app.project_id = 'x'",
    "copy": "COPY servers TO '/tmp/x'",
    "public_schema": "SELECT * FROM public.tenants",
    "tenant_schema": "SELECT * FROM client_acme.users",
    "bare_users": "SELECT * FROM users",
    "pg_catalog": "SELECT * FROM pg_catalog.pg_shadow",
    "information_schema": "SELECT * FROM information_schema.tables",
    "set_config": "SELECT set_config('app.project_id', 'x', false) FROM servers",
    "set_config_cased": "SELECT SET_CONFIG('app.project_id', 'x', false) FROM servers",
    "current_setting": "SELECT current_setting('app.project_id') FROM servers",
    "pg_sleep": "SELECT pg_sleep(10) FROM servers",
    "dblink": "SELECT dblink('x', 'select 1') FROM servers",
    "lo_import": "SELECT lo_import('/etc/passwd') FROM servers",
    "pg_read_file": "SELECT pg_read_file('/etc/passwd') FROM servers",
    "for_update": "SELECT * FROM servers FOR UPDATE",
    "select_into": "SELECT * INTO newt FROM servers",
    "unknown_fn_in_subquery": "SELECT * FROM servers WHERE id IN (SELECT pg_sleep(1))",
    "func_in_from": "SELECT * FROM pg_ls_dir('/')",
    "generate_series_in_from": "SELECT * FROM generate_series(1, 100000000)",
    "no_time_window": "SELECT * FROM tamper_alerts",
    "qualified_ok_name": "SELECT * FROM forensics.servers",
    "qualified_tenant": "SELECT * FROM client_acme.servers",
    "time_window_only_in_select": "SELECT detected_at FROM tamper_alerts",
    "empty": "",
    "garbage": "this is not sql",
    "comment_smuggle": "SELECT 1 FROM servers /* ; DROP TABLE servers */; DROP TABLE servers",
}


@pytest.mark.parametrize("sql", OK)
def test_accepts_valid_select(sql):
    out = guard_sql(sql)
    assert out.lstrip().lower().startswith("select")
    assert ";" not in out.rstrip().rstrip(";")


@pytest.mark.parametrize("name", list(BAD))
def test_rejects(name):
    with pytest.raises(GuardError):
        guard_sql(BAD[name])


def test_wraps_with_row_cap():
    out = guard_sql("SELECT * FROM servers", max_rows=50)
    assert "LIMIT 50" in out.upper().replace("  ", " ")


def test_user_limit_cannot_exceed_cap():
    out = guard_sql("SELECT * FROM servers LIMIT 999999", max_rows=50)
    # outer cap still applies regardless of inner limit
    assert out.upper().rstrip().endswith("LIMIT 50")


def test_cte_name_may_shadow_nothing_dangerous():
    # a CTE named like a forbidden table must not unlock it
    with pytest.raises(GuardError):
        guard_sql("WITH users AS (SELECT * FROM users) SELECT * FROM users")


def test_scopes_every_project_table_to_project():
    out = guard_sql(
        "SELECT a.id FROM tamper_alerts a JOIN servers s ON s.id = a.server_id "
        "JOIN sentinel_agents g ON g.server_id = s.id JOIN canary_decoy_files d ON d.server_id = s.id "
        "WHERE a.detected_at > now() - interval '1 day'")
    assert out.count(PID) == 4  # one scope filter per table reference
    assert "JOIN servers" in out  # scope subquery for server_id tables


def test_scope_survives_subqueries_and_ctes():
    out = guard_sql(
        "WITH x AS (SELECT * FROM servers) SELECT * FROM x WHERE id IN (SELECT server_id FROM sentinel_agents)")
    assert out.count(PID) == 2


@pytest.mark.parametrize("pid", ["", "x", "1; DROP TABLE servers", "11111111-2222-3333-4444-5555555555'"])
def test_rejects_non_uuid_project(pid):
    with pytest.raises(GuardError):
        _guard("SELECT 1 FROM servers", pid)
