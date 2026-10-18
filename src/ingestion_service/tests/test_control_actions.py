"""GET /control/actions: mTLS-authenticated, pops the caller's queued remote actions (process quarantine).

Identity comes only from the verified client-cert CN. Queue key is pending_actions:{slug}.{sentinel_id}.
"""
import os
os.environ.setdefault("JWT_SECRET", "t")
os.environ.setdefault("BOOTSTRAP_JWT_SECRET", "t")

import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

SID = "34d0222e-5f7b-4b7f-b1be-023377ec8f8f"
CERT = {"X-Client-Cert-DN": f"CN=mock-acme.{SID}.canary.local"}
KEY = f"pending_actions:mock-acme.{SID}"
KILL = {"action": "KILL_PROCESS", "pid": 4921, "exe": "/usr/bin/tail", "alert_id": "a1"}


class FakePipe:
    def __init__(self, store):
        self.store, self.ops = store, []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def lrange(self, key, a, b):
        self.ops.append(("lrange", key))

    def delete(self, key):
        self.ops.append(("delete", key))

    async def execute(self):
        out = []
        for op, key in self.ops:
            out.append(list(self.store.get(key, [])) if op == "lrange" else self.store.pop(key, None))
        return out


class FakeRedis:
    def __init__(self, store):
        self.store = store

    def pipeline(self, transaction=True):
        return FakePipe(self.store)


@pytest.fixture
def queue(monkeypatch):
    import main
    store = {}
    monkeypatch.setattr(main, "_is_revoked", AsyncMock(return_value=False))
    monkeypatch.setattr(main.liveness_mgr, "redis", FakeRedis(store), raising=False)
    return store


def get(headers=None):
    import main

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://t") as c:
            return await c.get("/control/actions", headers=headers or {})

    return asyncio.run(go())


def test_no_client_cert_is_unauthorized(queue):
    queue[KEY] = [json.dumps(KILL)]
    assert get().status_code == 401
    assert queue[KEY]  # untouched


@pytest.mark.parametrize("cn", ["acme", "a:b.c", "acme.id.extra"])
def test_malformed_cert_cn_is_forbidden(queue, cn):
    assert get({"X-Client-Cert-DN": f"CN={cn}.canary.local"}).status_code == 403


def test_revoked_agent_is_forbidden(queue, monkeypatch):
    import main
    queue[KEY] = [json.dumps(KILL)]
    monkeypatch.setattr(main, "_is_revoked", AsyncMock(return_value=True))
    assert get(CERT).status_code == 403
    assert queue[KEY]


def test_empty_queue(queue):
    r = get(CERT)
    assert r.status_code == 200 and r.json() == {"actions": []}


def test_returns_actions_once_and_clears(queue):
    queue[KEY] = [json.dumps(KILL)]
    assert get(CERT).json() == {"actions": [KILL]}
    assert get(CERT).json() == {"actions": []}


def test_other_tenant_or_agent_queue_not_visible(queue):
    queue[f"pending_actions:victim.{SID}"] = [json.dumps(KILL)]
    queue["pending_actions:mock-acme.99999999-9999-9999-9999-999999999999"] = [json.dumps(KILL)]
    assert get(CERT).json() == {"actions": []}


def test_header_spoofing_does_not_override_cert(queue):
    queue[f"pending_actions:victim.{SID}"] = [json.dumps(KILL)]
    hdrs = dict(CERT)
    hdrs.update({"X-Company-Slug": "victim", "X-Tenant-Slug": "victim"})
    assert get(hdrs).json() == {"actions": []}


@pytest.mark.parametrize("bad", [
    "not json", json.dumps([1]), json.dumps({"action": "RM_RF", "pid": 5, "exe": "/x"}),
    json.dumps({"action": "KILL_PROCESS", "pid": "5", "exe": "/x"}),
    json.dumps({"action": "KILL_PROCESS", "pid": 1, "exe": "/x"}),
    json.dumps({"action": "KILL_PROCESS", "pid": 5}),
])
def test_malformed_queue_entries_dropped(queue, bad):
    queue[KEY] = [bad, json.dumps(KILL)]
    assert get(CERT).json() == {"actions": [KILL]}


def test_redis_failure_is_503_without_leak(queue, monkeypatch):
    import main

    class Boom:
        def pipeline(self, transaction=True):
            raise RuntimeError("redis://:secret@host")

    monkeypatch.setattr(main.liveness_mgr, "redis", Boom(), raising=False)
    r = get(CERT)
    assert r.status_code == 503 and "secret" not in r.text


# ---------------------------------------------------------------- POST /control/actions/result

def post_result(headers=None, body=None):
    import main

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://t") as c:
            return await c.post("/control/actions/result", headers=headers or {}, json=body)

    return asyncio.run(go())


@pytest.fixture
def relay(monkeypatch):
    import main
    from unittest.mock import MagicMock
    m = MagicMock(return_value={"updated": 1})
    monkeypatch.setattr(main, "_platform_post_action_result", m, raising=False)
    monkeypatch.setattr(main, "_is_revoked", AsyncMock(return_value=False))
    return m


GOOD = {"alert_id": "00000000-0000-0000-0000-0000000000a1", "ok": True, "message": "killed"}


def test_result_requires_cert(relay):
    assert post_result(body=GOOD).status_code == 401
    relay.assert_not_called()


def test_result_revoked_forbidden(relay, monkeypatch):
    import main
    monkeypatch.setattr(main, "_is_revoked", AsyncMock(return_value=True))
    assert post_result(CERT, GOOD).status_code == 403
    relay.assert_not_called()


@pytest.mark.parametrize("body", [{}, {"alert_id": "nope", "ok": True}, {"alert_id": GOOD["alert_id"], "ok": "yes"}])
def test_result_bad_body_422(relay, body):
    assert post_result(CERT, body).status_code == 422
    relay.assert_not_called()


def test_result_relays_with_identity_from_cert_only(relay):
    hdrs = dict(CERT)
    hdrs["X-Company-Slug"] = "victim"
    assert post_result(hdrs, GOOD).status_code == 200
    relay.assert_called_once_with("mock-acme", SID, GOOD["alert_id"], True, "killed")


def test_result_platform_failure_502(relay):
    relay.side_effect = RuntimeError("tok-secret")
    r = post_result(CERT, GOOD)
    assert r.status_code == 502 and "tok-secret" not in r.text


# ---------------------------------------------------------------- optional parent-shell target

WITH_PARENT = {**KILL, "ppid": 3250287, "parent_comm": "bash"}


def test_parent_fields_pass_through_when_valid(queue):
    queue[KEY] = [json.dumps(WITH_PARENT)]
    assert get(CERT).json() == {"actions": [WITH_PARENT]}


@pytest.mark.parametrize("extra", [
    {"ppid": 1, "parent_comm": "init"},
    {"ppid": "9", "parent_comm": "bash"},
    {"ppid": True, "parent_comm": "bash"},
    {"ppid": 300},
    {"ppid": 300, "parent_comm": ""},
    {"parent_comm": "bash"},
])
def test_invalid_parent_fields_drop_the_action(queue, extra):
    queue[KEY] = [json.dumps({**KILL, **extra}), json.dumps(KILL)]
    assert get(CERT).json() == {"actions": [KILL]}
