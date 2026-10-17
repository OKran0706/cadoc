"""CANARY_CLEANUP ack: a sentinel reports leftover canaries it removed; the writer marks them
cleaned_up, scoped to the sender's own server. Negative cases first."""
from unittest.mock import MagicMock

import pytest

from test_event_writer import FakeSession, IDENT, SID, run, sqls

A = "0b9c1f7e-0000-4000-8000-000000000001"
B = "0b9c1f7e-0000-4000-8000-000000000002"
UPDATE = "SET status = 'cleaned_up'"


def ack(ids, **extra):
    return {"type": "CANARY_CLEANUP", "ids": ids, **extra}


# ---------------------------------------------------------------- negative

@pytest.mark.parametrize("ids", [None, "abc", A, 5, {"a": 1}, True, 1.5])
def test_non_list_ids_ignored(ids, monkeypatch):
    s = FakeSession()
    run(IDENT, ack(ids), s, monkeypatch)
    assert not sqls(s, UPDATE)


def test_missing_ids_key_ignored(monkeypatch):
    s = FakeSession()
    run(IDENT, {"type": "CANARY_CLEANUP"}, s, monkeypatch)
    assert not sqls(s, UPDATE)


@pytest.mark.parametrize("ids", [[], [""], ["not-a-uuid"], ["' OR 1=1 --"], [A + "x"], ["../../etc"], [None], [5], [[A]], [{"id": A}]])
def test_empty_or_invalid_ids_issue_no_update(ids, monkeypatch):
    s = FakeSession()
    run(IDENT, ack(ids), s, monkeypatch)
    assert not sqls(s, UPDATE)


def test_invalid_entries_are_dropped_valid_ones_kept(monkeypatch):
    s = FakeSession()
    run(IDENT, ack(["bad", A, None, 7, "'; DROP TABLE x;--", B]), s, monkeypatch)
    (_, params), = sqls(s, UPDATE)
    assert params["ids"] == [A, B]


def test_duplicate_ids_collapsed(monkeypatch):
    s = FakeSession()
    run(IDENT, ack([A, A, A.upper(), B]), s, monkeypatch)
    (_, params), = sqls(s, UPDATE)
    assert params["ids"] == [A, B]


def test_oversized_batch_is_capped(monkeypatch):
    s = FakeSession()
    many = [f"00000000-0000-4000-8000-{i:012d}" for i in range(5000)]
    run(IDENT, ack(many), s, monkeypatch)
    (_, params), = sqls(s, UPDATE)
    assert len(params["ids"]) == 1000


def test_update_is_scoped_to_senders_own_server(monkeypatch):
    s = FakeSession()
    # a sender cannot name another server: identity (cert) decides, payload fields are ignored
    other = "11111111-1111-4111-8111-111111111111"
    run(IDENT, ack([A], server_id=other, sid=other, slug="victim"), s, monkeypatch)
    (sql, params), = sqls(s, UPDATE)
    assert "server_id = CAST(:sid AS uuid)" in sql
    assert params["sid"] == SID
    assert "client_mock-acme" in sql and "victim" not in sql


def test_update_only_touches_planted_or_tampered(monkeypatch):
    s = FakeSession()
    run(IDENT, ack([A]), s, monkeypatch)
    (sql, _), = sqls(s, UPDATE)
    assert "status IN ('planted', 'tampered', 'orphaned')" in sql
    assert "verification_failed" not in sql


def test_ids_are_bound_parameters_never_interpolated(monkeypatch):
    s = FakeSession()
    run(IDENT, ack([A]), s, monkeypatch)
    (sql, _), = sqls(s, UPDATE)
    assert A not in sql


def test_bad_identity_touches_nothing(monkeypatch):
    s = FakeSession()
    run("garbage", ack([A]), s, monkeypatch)
    assert s.calls == []


def test_no_alert_and_nothing_published(monkeypatch):
    s = FakeSession()
    run(IDENT, ack([A]), s, monkeypatch)
    assert not sqls(s, "tamper_alerts")
    assert s.published == []


def test_db_error_rolls_back(monkeypatch):
    s = FakeSession()

    async def boom(stmt, params=None):
        raise RuntimeError("db down")

    s.execute = boom
    run(IDENT, ack([A]), s, monkeypatch)
    s.rollback.assert_awaited_once()
    s.commit.assert_not_awaited()


# ---------------------------------------------------------------- positive

def test_valid_ack_marks_cleaned_up_and_commits(monkeypatch):
    s = FakeSession()
    run(IDENT, ack([A, B]), s, monkeypatch)
    assert len(sqls(s, UPDATE)) == 1
    s.commit.assert_awaited_once()

