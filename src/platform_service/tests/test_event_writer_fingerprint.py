"""SENTINEL_FINGERPRINT: a re-added server is recognised by its fingerprint. When the earlier
agent is dead, the earlier record's history and mappings are folded into the NEW server row
(the one whose id is in the sentinel's certificate) and the earlier row is deleted.
Negative cases first."""
import json
import re
from unittest.mock import MagicMock

import pytest

from test_event_writer import FakeSession, IDENT, SID, run, sqls

OLD = "33333333-3333-4333-8333-333333333333"
PROJ = "44444444-4444-4444-8444-444444444444"
FP = "ab" * 32
SCHEMA = '"client_mock-acme"'


def fp_event(fp=FP, **extra):
    return {"type": "SENTINEL_FINGERPRINT", "fingerprint": fp, **extra}


def own_row(fingerprint=None):
    return MagicMock(id=SID, fingerprint=fingerprint)


def session(own=True, match=False, live=False, own_fp=None):
    rows = {}
    if own:
        rows["SELECT id, fingerprint"] = own_row(own_fp)
    if match:
        rows["WHERE fingerprint"] = MagicMock(id=OLD, project_id=PROJ)
    if live:
        rows["NOT IN ('offline', 'decommissioned')"] = MagicMock()
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


# ---------------------------------------------------------------- match but old agent alive: never merge

def test_live_old_agent_raises_alert_and_does_not_merge(monkeypatch):
    s = session(match=True, live=True)
    run(IDENT, fp_event(), s, monkeypatch)
    alerts = sqls(s, f"INSERT INTO {SCHEMA}.tamper_alerts")
    assert len(alerts) == 1
    assert alerts[0][1]["etype"] == "DUPLICATE_FINGERPRINT" and alerts[0][1]["sev"] == "high"
    d = json.loads(alerts[0][1]["details"])
    assert d["existing_server_id"] == OLD and d["new_server_id"] == SID
    for forbidden in ("DELETE FROM", "SET server_id", "SET project_id", "server_roles", "'orphaned'",
                      "'decommissioned'", "SET fingerprint"):
        assert not [m for m in mutations(s) if forbidden in m[0]], forbidden


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


# ---------------------------------------------------------------- no alias machinery

def test_merge_never_mentions_aliases(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    assert not [sql for sql, _ in s.calls if "alias" in sql.lower()]


def test_ordinary_events_do_not_look_up_aliases(monkeypatch):
    s = FakeSession(rows={f"FROM {SCHEMA}.canary_decoy_files": MagicMock(id="decoy-1")})
    run(IDENT, {"type": "SENTINEL_FILE_READ", "op": "READ", "path": "/etc/app/a.bak"}, s, monkeypatch)
    assert not [sql for sql, _ in s.calls if "alias" in sql.lower()]
    (_, params), = sqls(s, f"INSERT INTO {SCHEMA}.tamper_alerts")
    assert params["sid"] == SID


# ---------------------------------------------------------------- merge (dead old agent): negative invariants

def test_merge_deletes_the_old_server_never_the_senders(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    (_, params), = sqls(s, f"DELETE FROM {SCHEMA}.servers")
    assert params == {"old": OLD}
    assert SID not in params.values()


def test_merge_does_not_overwrite_the_new_rows_characteristics(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    (sql, _), = sqls(s, f"UPDATE {SCHEMA}.servers SET")
    for col in ("hostname", "ip_address", "specs", "status"):
        assert col not in sql, f"{col} must keep the new server's value"


def test_merge_orphans_only_the_old_servers_planted_rows(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    (sql, params), = sqls(s, "SET status = 'orphaned'")
    assert "status = 'planted'" in sql and params == {"old": OLD}
    assert "tampered" not in sql


def test_merge_leaves_the_new_servers_own_decoys_alone(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    for sql, params in mutations(s):
        if "canary_decoy_files" in sql:
            assert params.get("old") == OLD, "only rows of the old server may be touched"


def test_merge_discards_new_servers_roles_before_adopting_old_ones(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    (_, drop), = sqls(s, f"DELETE FROM {SCHEMA}.server_roles")
    assert drop == {"new": SID}
    (_, move), = sqls(s, f"UPDATE {SCHEMA}.server_roles SET server_id")
    assert move == {"old": OLD, "new": SID}
    assert idx(s, f"DELETE FROM {SCHEMA}.server_roles") < idx(s, f"UPDATE {SCHEMA}.server_roles SET server_id")


# ---------------------------------------------------------------- merge: ordering and happy path

def test_dead_old_agent_merges_in_safe_order(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    i_match = idx(s, "WHERE fingerprint")
    i_live = idx(s, "NOT IN ('offline', 'decommissioned')")
    i_decom = idx(s, f"UPDATE {SCHEMA}.sentinel_agents SET status = 'decommissioned'")
    i_agents = idx(s, f"UPDATE {SCHEMA}.sentinel_agents SET server_id")
    i_orphan = idx(s, "SET status = 'orphaned'")
    i_decoys = idx(s, f"UPDATE {SCHEMA}.canary_decoy_files SET server_id")
    i_alerts = idx(s, f"UPDATE {SCHEMA}.tamper_alerts SET server_id")
    i_roles = idx(s, f"UPDATE {SCHEMA}.server_roles SET server_id")
    i_delete = idx(s, f"DELETE FROM {SCHEMA}.servers")
    i_final = idx(s, f"UPDATE {SCHEMA}.servers SET")
    assert i_match < i_live < i_decom < i_agents                # old project read and liveness checked first
    assert i_orphan < i_decoys                                  # orphan before re-pointing
    assert max(i_agents, i_decoys, i_alerts, i_roles) < i_delete  # nothing left to cascade-delete
    assert i_delete < i_final
    s.commit.assert_awaited_once()


def test_merge_repoints_history_onto_the_new_server(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    for table in ("sentinel_agents", "canary_decoy_files", "tamper_alerts", "server_roles"):
        (_, params), = sqls(s, f"UPDATE {SCHEMA}.{table} SET server_id")
        assert params == {"old": OLD, "new": SID}, table


def test_merge_retires_the_old_agent(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    (_, params), = sqls(s, f"UPDATE {SCHEMA}.sentinel_agents SET status = 'decommissioned'")
    assert params == {"old": OLD}


def test_merge_keeps_old_project_and_stores_fingerprint(monkeypatch):
    s = session(match=True)
    run(IDENT, fp_event(), s, monkeypatch)
    (sql, params), = sqls(s, f"UPDATE {SCHEMA}.servers SET")
    assert "project_id" in sql and "fingerprint" in sql
    assert params["project"] == PROJ and params["fp"] == FP and params["new"] == SID


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


def test_map_deploy_does_not_clear_orphaned_rows(monkeypatch):
    s = FakeSession()
    run(IDENT, {"type": "CANARY_MAP_DEPLOYED", "map": {"canaries": []}}, s, monkeypatch)
    (sql, _), = sqls(s, "SET status = 'cleaned_up'")
    assert "status = 'planted'" in sql and "orphaned" not in sql
