import asyncio
from contextlib import asynccontextmanager
from datetime import timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services import event_writer as ew

SID = "34d0222e-5f7b-4b7f-b1be-023377ec8f8f"
IDENT = f"mock-acme.{SID}"
HASH = "a" * 64


class FakeSession:
    """Records executed SQL; returns scripted rows for SELECTs by substring match."""

    def __init__(self, rows=None):
        self.calls = []          # (sql, params)
        self.rows = rows or {}   # substring -> row (or None)
        self.begin = AsyncMock()
        self.commit = AsyncMock()
        self.rollback = AsyncMock()

    async def execute(self, stmt, params=None):
        sql = str(stmt)
        self.calls.append((sql, params or {}))
        res = MagicMock()
        for needle, row in self.rows.items():
            if needle in sql:
                res.fetchone.return_value = row
                return res
        res.fetchone.return_value = None
        return res


def run(identity, payload, session, monkeypatch):
    @asynccontextmanager
    async def factory():
        yield session

    published = []

    async def fake_publish(slug, msg):
        published.append((slug, msg))

    monkeypatch.setattr(ew, "async_session_factory", factory)
    monkeypatch.setattr(ew, "publish", fake_publish)
    asyncio.run(ew.handle_event(identity, payload))
    session.published = published


def sqls(session, needle):
    return [(s, p) for s, p in session.calls if needle in s]


def test_parse_identity_and_ts():
    assert ew.parse_identity(IDENT) == ("mock-acme", SID)
    for bad in ["", "acme", "a:b.c", "acme.x.y"]:
        assert ew.parse_identity(bad) is None
    dt = ew.parse_ts("2026-10-17T09:50:50.189782975Z")  # Go RFC3339Nano (9 digits)
    assert dt.tzinfo == timezone.utc and dt.microsecond == 189782
    assert ew.parse_ts(None).tzinfo is not None


def test_map_deploy_replaces_previous_and_inserts(monkeypatch):
    s = FakeSession()
    payload = {"type": "CANARY_MAP_DEPLOYED", "map": {"canaries": [
        {"id": "0b9c1f7e-0000-4000-8000-000000000001", "path": "/etc/app/a.bak", "type": "config_backup",
         "sha256": HASH, "planted_at": "2026-10-17T10:00:00Z"},
        {"id": "0b9c1f7e-0000-4000-8000-000000000002", "path": "/x", "type": "env_file",
         "sha256": "not-a-hash", "planted_at": "2026-10-17T10:00:00Z"},
    ]}}
    run(IDENT, payload, s, monkeypatch)
    assert len(sqls(s, "SET status = 'cleaned_up'")) == 1
    ins = sqls(s, "INSERT INTO \"client_mock-acme\".canary_decoy_files")
    assert len(ins) == 1 and ins[0][1]["path"] == "/etc/app/a.bak" and ins[0][1]["sid"] == SID  # bad hash skipped
    s.commit.assert_awaited_once()


def test_file_event_on_known_decoy_raises_alert_and_marks_tampered(monkeypatch):
    s = FakeSession(rows={"FROM \"client_mock-acme\".canary_decoy_files": MagicMock(id="decoy-1")})
    payload = {"type": "SENTINEL_FILE_READ", "op": "READ", "path": "/etc/app/a.bak", "pid": 42,
               "audit_id": "1:2", "confidence": "high", "ts": "2026-10-17T10:00:00.5Z"}
    run(IDENT, payload, s, monkeypatch)
    alert = sqls(s, "INSERT INTO \"client_mock-acme\".tamper_alerts")
    assert len(alert) == 1
    assert alert[0][1]["etype"] == "DECOY_TAMPER" and alert[0][1]["sev"] == "high"
    assert len(sqls(s, "ensure_monthly_range_partition")) == 1
    assert len(sqls(s, "SET status = 'tampered'")) == 1


def test_file_write_is_critical(monkeypatch):
    s = FakeSession(rows={"FROM \"client_mock-acme\".canary_decoy_files": MagicMock(id="d")})
    run(IDENT, {"type": "SENTINEL_FILE_WRITE", "op": "WRITE", "path": "/p"}, s, monkeypatch)
    assert sqls(s, "INSERT INTO \"client_mock-acme\".tamper_alerts")[0][1]["sev"] == "critical"


def test_file_event_on_unknown_path_is_ignored(monkeypatch):
    s = FakeSession()  # decoy lookup returns None
    run(IDENT, {"type": "SENTINEL_FILE_WRITE", "op": "WRITE", "path": "/etc/passwd"}, s, monkeypatch)
    assert not sqls(s, "tamper_alerts")


def test_binary_tamper_maps_to_system_alert(monkeypatch):
    s = FakeSession()
    run(IDENT, {"type": "BINARY_TAMPERED", "host": "h", "seq": 3, "prev_hash": "x"}, s, monkeypatch)
    a = sqls(s, "INSERT INTO \"client_mock-acme\".tamper_alerts")[0][1]
    assert a["etype"] == "BINARY_TAMPER" and a["sev"] == "critical" and "prev_hash" not in a["details"]


@pytest.mark.parametrize("identity,etype", [("", "SENTINEL_FILE_READ"), ("bad", "CANARY_MAP_DEPLOYED"),
                                            (IDENT, "SENTINEL_CAPABILITY_SET"), (IDENT, "SELFMON_MODE_SELECTED")])
def test_bad_identity_or_uninteresting_type_touches_nothing(identity, etype, monkeypatch):
    s = FakeSession()
    run(identity, {"type": etype, "path": "/p", "op": "READ"}, s, monkeypatch)
    assert s.calls == []


def test_db_error_rolls_back(monkeypatch):
    s = FakeSession()

    async def boom(stmt, params=None):
        raise RuntimeError("db down")

    s.execute = boom
    run(IDENT, {"type": "BINARY_TAMPERED"}, s, monkeypatch)
    s.rollback.assert_awaited_once()
    s.commit.assert_not_awaited()
    assert s.published == []  # nothing live for rolled-back work


def test_alert_is_published_live_after_commit(monkeypatch):
    s = FakeSession(rows={"FROM \"client_mock-acme\".canary_decoy_files": MagicMock(id="d")})
    run(IDENT, {"type": "SENTINEL_FILE_WRITE", "op": "WRITE", "path": "/p"}, s, monkeypatch)
    s.commit.assert_awaited_once()
    (slug, msg), = s.published
    assert slug == "mock-acme" and msg["type"] == "alert" and msg["server_id"] == SID
    assert msg["event_type"] == "DECOY_TAMPER" and msg["severity"] == "critical" and "id" in msg


def test_non_alert_events_publish_nothing(monkeypatch):
    s = FakeSession()
    run(IDENT, {"type": "CANARY_MAP_DEPLOYED", "map": {"canaries": []}}, s, monkeypatch)
    run(IDENT, {"type": "SENTINEL_FILE_READ", "op": "READ", "path": "/not-a-decoy"}, s, monkeypatch)
    assert s.published == []


def test_map_duplicate_paths_keep_last_entry(monkeypatch):
    s = FakeSession()
    c = lambda i, h: {"id": f"0b9c1f7e-0000-4000-8000-00000000000{i}", "path": "/etc/app/config.yml.old",
                      "type": "config_backup", "sha256": h, "planted_at": "2026-10-17T10:00:00Z"}
    run(IDENT, {"type": "CANARY_MAP_DEPLOYED", "map": {"canaries": [c(1, "a" * 64), c(2, "b" * 64)]}}, s, monkeypatch)
    ins = sqls(s, "INSERT INTO \"client_mock-acme\".canary_decoy_files")
    assert len(ins) == 1 and ins[0][1]["hash"] == "b" * 64
