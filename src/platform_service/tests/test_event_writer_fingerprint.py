"""SENTINEL_FINGERPRINT: a re-added server is recognised by its fingerprint. When the earlier
agent is dead and the new server has no alerts yet, the new server row is folded into the
EARLIER record (its id, project, roles and alert history stay) and the new sentinel identity is
recorded as an alias of it. tamper_alerts are immutable in the database, so they are never
updated or deleted. Negative cases first."""
import json
import re
from unittest.mock import MagicMock

import pytest

from test_event_writer import FakeSession, IDENT, SID, run, sqls

OLD = "33333333-3333-4333-8333-333333333333"
FP = "ab" * 32
SCHEMA = '"client_mock-acme"'


def fp_event(fp=FP, **extra):
    return {"type": "SENTINEL_FINGERPRINT", "fingerprint": fp, **extra}


def own_row(fingerprint=None):
    return MagicMock(id=SID, fingerprint=fingerprint, hostname="web-02.internal",
                     ip_address="10.0.0.5", specs={"cpu": 4}, status="online")


def session(own=True, match=False, live=False, own_fp=None, new_has_alerts=False):
    rows = {}
    if own:
        rows["SELECT id, fingerprint"] = own_row(own_fp)
    if match:
        rows["WHERE fingerprint"] = MagicMock(id=OLD)
    if live:
        rows["NOT IN ('offline', 'decommissioned')"] = MagicMock()
    if new_has_alerts:
        rows[f"FROM {SCHEMA}.tamper_alerts"] = MagicMock()
    return FakeSession(rows=rows)


def mutations(s):
    return [(sql, p) for sql, p in s.calls if sql.lstrip().upper().startswith(("UPDATE", "DELETE", "INSERT"))]


def idx(s, needle):
    for i, (sql, _) in enumerate(s.calls):
        if needle in sql:
            return i
    raise AssertionError(f"no SQL containing {needle!r}")


# ---------------------------------------------------------------- invalid input: negative

@pytest.mark.parametrize("fp", [None, "", "abc", "g" * 64, "a" * 63, "a" * 65, 12345, ["a" * 64], {"a": 1},
                                " " + "a" * 63, "a" * 63 + "\n", "a" * 32 + "'; DROP TABLE x;--"])
def test_invalid_fingerprint_causes_no_writes(fp, monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(fp), s, monkeypatch)
    assert mutations(s) == []


def test_missing_fingerprint_key_causes_no_writes(monkeypatch):
    s = session(match=True)
    run(IDENT, {"type": "SENTINEL_FINGERPRINT"}, s, monkeypatch)
    assert mutations(s) == []


def test_unknown_own_server_causes_no_writes(monkeypatch):
    s = session(own=False, match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    assert mutations(s) == []


def test_bad_identity_touches_nothing(monkeypatch):
    s = session(match=True)
    run("garbage", fp_event(), s, monkeypatch)
    assert s.calls == []


def test_same_fingerprint_resent_is_a_noop(monkeypatch):
    s = session(own_fp=FP, match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    assert mutations(s) == []
    assert s.published == []


# ---------------------------------------------------------------- no match: store only

def test_first_sighting_stores_fingerprint_only(monkeypatch):
    s = session()
    run(IDENT, fp_event(), s, monkeypatch)
    muts = mutations(s)
    assert len(muts) == 1
    sql, params = muts[0]
    assert "SET fingerprint" in sql and params["fp"] == FP and params["sid"] == SID
    s.commit.assert_awaited_once()


# ---------------------------------------------------------------- match but never safe to merge

def test_live_old_agent_raises_alert_and_does_not_merge(monkeypatch):
    s = session(match=True, live=True)
    run(IDENT, fp_event(), s, monkeypatch)
    alerts = sqls(s, f"INSERT INTO {SCHEMA}.tamper_alerts")
    assert len(alerts) == 1
    assert alerts[0][1]["etype"] == "DUPLICATE_FINGERPRINT" and alerts[0][1]["sev"] == "high"
    d = json.loads(alerts[0][1]["details"])
    assert d["existing_server_id"] == OLD and d["new_server_id"] == SID
    for forbidden in ("DELETE FROM", "SET server_id", "server_aliases", "'orphaned'", "'decommissioned'",
                      "SET hostname", "SET fingerprint"):
        assert not [m for m in mutations(s) if forbidden in m[0]], forbidden


def test_new_server_with_alerts_is_never_deleted(monkeypatch):
    # tamper_alerts cannot be moved or deleted, so a server that has any is left alone.
    s = session(match=True, new_has_alerts=True)
    run(IDENT, fp_event(), s, monkeypatch)
    alerts = sqls(s, f"INSERT INTO {SCHEMA}.tamper_alerts")
    assert len(alerts) == 1 and alerts[0][1]["etype"] == "DUPLICATE_FINGERPRINT"
    assert "alerts" in json.loads(alerts[0][1]["details"])["reason"]
    assert not [m for m in mutations(s) if "DELETE FROM" in m[0] or "SET server_id" in m[0]
                or "server_aliases" in m[0]]


def test_live_check_treats_any_non_dead_agent_as_alive(monkeypatch):
    s = session(match=True, live=True)
    run(IDENT, fp_event(), s, monkeypatch)
    (sql, _), = sqls(s, "NOT IN ('offline', 'decommissioned')")
    assert "server_id" in sql and "sentinel_agents" in sql


def test_live_old_agent_publishes_the_alert(monkeypatch):
    s = session(match=True, live=True)
    run(IDENT, fp_event(), s, monkeypatch)
    assert len(s.published) == 1 and s.published[0][1]["event_type"] == "DUPLICATE_FINGERPRINT"


# ---------------------------------------------------------------- tenant isolation

def test_every_statement_is_scoped_to_the_senders_tenant(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    for sql, _ in s.calls:
        for schema in re.findall(r'"client_[^"]+"', sql):
            assert schema == SCHEMA, sql


def test_match_query_binds_fingerprint_and_excludes_self(monkeypatch):
    s = session()
    run(IDENT, fp_event(), s, monkeypatch)
    (sql, params), = sqls(s, "WHERE fingerprint")
    assert FP not in sql and params["fp"] == FP
    assert "<>" in sql and params["sid"] == SID


# ---------------------------------------------------------------- merge: negative invariants

def test_merge_never_updates_or_deletes_alerts(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    for sql, _ in mutations(s):
        if "tamper_alerts" in sql:
            assert sql.lstrip().upper().startswith("INSERT"), "tamper_alerts is immutable: " + sql


def test_merge_deletes_the_new_server_never_the_old(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    (_, params), = sqls(s, f"DELETE FROM {SCHEMA}.servers")
    assert params == {"new": SID}
    assert OLD not in params.values()


def test_merge_keeps_old_project_and_roles(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    assert not [m for m in mutations(s) if "server_roles" in m[0] or "project_id" in m[0]]


def test_merge_orphans_only_the_old_servers_planted_rows(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    (sql, params), = sqls(s, "SET status = 'orphaned'")
    assert "status = 'planted'" in sql and params == {"old": OLD}
    assert "tampered" not in sql


def test_merge_leaves_the_old_servers_own_agent_and_decoys_in_place(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    for table in ("sentinel_agents", "canary_decoy_files"):
        (_, params), = sqls(s, f"UPDATE {SCHEMA}.{table} SET server_id")
        assert params == {"old": OLD, "new": SID}, "re-point must move new -> old only"


# ---------------------------------------------------------------- merge: ordering and happy path

def test_dead_old_agent_merges_in_safe_order(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    i_live = idx(s, "NOT IN ('offline', 'decommissioned')")
    i_guard = idx(s, f"FROM {SCHEMA}.tamper_alerts")
    i_decom = idx(s, f"UPDATE {SCHEMA}.sentinel_agents SET status = 'decommissioned'")
    i_orphan = idx(s, "SET status = 'orphaned'")
    i_agents = idx(s, f"UPDATE {SCHEMA}.sentinel_agents SET server_id")
    i_decoys = idx(s, f"UPDATE {SCHEMA}.canary_decoy_files SET server_id")
    i_delete = idx(s, f"DELETE FROM {SCHEMA}.servers")
    i_update = idx(s, f"UPDATE {SCHEMA}.servers SET hostname")
    i_alias = idx(s, f"INSERT INTO {SCHEMA}.server_aliases")
    assert i_live < i_guard < i_decom                       # all checks before any write
    assert i_decom < i_agents and i_orphan < i_decoys       # retire/orphan old before re-pointing new
    assert max(i_agents, i_decoys) < i_delete               # nothing left to cascade away
    assert i_delete < i_update                              # free the UNIQUE hostname first
    assert i_alias > i_delete
    s.commit.assert_awaited_once()


def test_merge_gives_the_old_record_the_new_characteristics(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    (sql, params), = sqls(s, f"UPDATE {SCHEMA}.servers SET hostname")
    assert params["old"] == OLD and params["fp"] == FP
    assert params["hostname"] == "web-02.internal" and params["ip"] == "10.0.0.5"
    assert params["status"] == "online" and json.loads(params["specs"]) == {"cpu": 4}


def test_merge_records_alias_and_repoints_existing_aliases(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    (_, params), = sqls(s, f"INSERT INTO {SCHEMA}.server_aliases")
    assert params == {"alias": SID, "old": OLD}
    (_, move), = sqls(s, f"UPDATE {SCHEMA}.server_aliases SET server_id")
    assert move == {"old": OLD, "new": SID}
    assert idx(s, f"UPDATE {SCHEMA}.server_aliases SET server_id") < idx(s, f"DELETE FROM {SCHEMA}.servers")


def test_merge_publishes_nothing(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    assert s.published == []


def test_db_error_mid_merge_rolls_back(monkeypatch):
    s = session(match=True)
    real = s.execute

    async def flaky(stmt, params=None):
        if "DELETE FROM" in str(stmt):
            raise RuntimeError("fk violation")
        return await real(stmt, params)

    s.execute = flaky
    run(IDENT, fp_event(), s, monkeypatch)
    s.rollback.assert_awaited_once()
    s.commit.assert_not_awaited()
    assert s.published == []


# ---------------------------------------------------------------- alias resolution for other events

def test_alias_lookup_is_scoped_and_bound(monkeypatch):
    s = FakeSession()
    run(IDENT, {"type": "CANARY_MAP_DEPLOYED", "map": {"canaries": []}}, s, monkeypatch)
    (sql, params), = sqls(s, "server_aliases")
    assert f"{SCHEMA}.server_aliases" in sql and params == {"sid": SID}


def test_events_from_merged_identity_are_recorded_under_survivor(monkeypatch):
    surv = "22222222-2222-4222-8222-222222222222"
    s = FakeSession(rows={"server_aliases": MagicMock(server_id=surv),
                          f"FROM {SCHEMA}.canary_decoy_files": MagicMock(id="decoy-1")})
    run(IDENT, {"type": "SENTINEL_FILE_READ", "op": "READ", "path": "/etc/app/a.bak"}, s, monkeypatch)
    (_, params), = sqls(s, f"INSERT INTO {SCHEMA}.tamper_alerts")
    assert params["sid"] == surv


def test_map_deploy_from_merged_identity_inserts_under_survivor(monkeypatch):
    surv = "22222222-2222-4222-8222-222222222222"
    s = FakeSession(rows={"server_aliases": MagicMock(server_id=surv)})
    payload = {"type": "CANARY_MAP_DEPLOYED", "map": {"canaries": [
        {"id": "0b9c1f7e-0000-4000-8000-000000000001", "path": "/etc/app/a.bak", "type": "config_backup",
         "sha256": "a" * 64, "planted_at": "2026-10-17T10:00:00Z"}]}}
    run(IDENT, payload, s, monkeypatch)
    (_, params), = sqls(s, f"INSERT INTO {SCHEMA}.canary_decoy_files")
    assert params["sid"] == surv


def test_fingerprint_from_merged_identity_is_a_noop(monkeypatch):
    surv = "22222222-2222-4222-8222-222222222222"
    rows = {"server_aliases": MagicMock(server_id=surv), "SELECT id, fingerprint": own_row(FP)}
    s = FakeSession(rows=rows)
    run(IDENT, fp_event(), s, monkeypatch)
    assert mutations(s) == []


def test_map_deploy_does_not_clear_orphaned_rows(monkeypatch):
    s = FakeSession()
    run(IDENT, {"type": "CANARY_MAP_DEPLOYED", "map": {"canaries": []}}, s, monkeypatch)
    (sql, _), = sqls(s, "SET status = 'cleaned_up'")
    assert "status = 'planted'" in sql and "orphaned" not in sql
