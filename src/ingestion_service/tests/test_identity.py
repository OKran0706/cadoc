import os
os.environ.setdefault("JWT_SECRET", "t")
os.environ.setdefault("BOOTSTRAP_JWT_SECRET", "t")

import pytest
from liveness import parse_agent_cn

UUID = "34d0222e-5f7b-4b7f-b1be-023377ec8f8f"


@pytest.fixture(autouse=True)
def not_revoked(monkeypatch):
    """No real Redis in unit tests; individual tests override _is_revoked."""
    import main
    from unittest.mock import AsyncMock
    monkeypatch.setattr(main, "_is_revoked", AsyncMock(return_value=False))


def test_vault_issued_cn():
    assert parse_agent_cn(f"mock-acme.{UUID}") == ("mock-acme", UUID)


def test_legacy_agent_cn():
    assert parse_agent_cn(f"agent:acme:{UUID}") == ("acme", UUID)


def test_rejects_malformed_and_key_injection():
    for bad in ["", "acme", "acme.", ".id", "agent:acme", "agent:a:b:c", "acme.id:evil", "a:b.c", "acme.id.extra"]:
        assert parse_agent_cn(bad) is None, bad


def _post(headers, payload):
    import asyncio, json, httpx
    from datetime import datetime, timezone
    from unittest.mock import AsyncMock, patch
    import main
    payload.setdefault("ts", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"))
    body = {"payload": json.dumps(payload), "signature": "00", "key_id": "k", "hash": "h"}

    async def go():
        with patch.object(main.liveness_mgr, "update_liveness", new=AsyncMock()) as live:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://t") as c:
                r = await c.post("/ingest", json=body, headers=headers)
            return r.status_code, live.await_count

    return asyncio.run(go())


def test_ingest_payload_id_must_match_cert():
    cert = {"X-Client-Cert-DN": f"CN=mock-acme.{UUID}.canary.local"}
    ok = _post(cert, {"type": "SENTINEL_HEARTBEAT", "id": f"mock-acme.{UUID}"})
    assert ok == (202, 1)
    spoof = _post(cert, {"type": "SENTINEL_HEARTBEAT", "id": "mock-acme.someone-else"})
    assert spoof == (403, 0)
    no_id = _post(cert, {"type": "SENTINEL_HEARTBEAT"})
    assert no_id == (202, 1)


def test_kafka_message_carries_verified_identity_header():
    import asyncio, json, httpx
    from datetime import datetime, timezone
    from unittest.mock import AsyncMock, patch
    import main

    payload = {"type": "SENTINEL_FILE_READ", "op": "READ", "path": "/etc/app/x",
               "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")}
    body = {"payload": json.dumps(payload), "signature": "00", "key_id": "k", "hash": "h"}
    producer = AsyncMock()

    async def go():
        with patch.object(main.state, "producer", producer):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://t") as c:
                return await c.post("/ingest", json=body,
                                    headers={"X-Client-Cert-DN": f"CN=mock-acme.{UUID}.canary.local"})

    assert asyncio.run(go()).status_code == 202
    producer.send_and_wait.assert_awaited_once()
    assert producer.send_and_wait.await_args.kwargs["headers"] == [("identity", f"mock-acme.{UUID}".encode())]


def test_decommissioned_agent_is_rejected(monkeypatch):
    import main
    from unittest.mock import AsyncMock
    monkeypatch.setattr(main, "_is_revoked", AsyncMock(return_value=True))
    cert = {"X-Client-Cert-DN": f"CN=mock-acme.{UUID}.canary.local"}
    assert _post(cert, {"type": "SENTINEL_HEARTBEAT"}) == (403, 0)  # no liveness key written
    assert _post(cert, {"type": "SENTINEL_FILE_READ", "op": "READ", "path": "/p"}) == (403, 0)


def test_is_revoked_looks_up_platform_key(monkeypatch):
    import asyncio
    import main
    from unittest.mock import AsyncMock
    monkeypatch.undo()  # drop the autouse stub, test the real function
    exists = AsyncMock(return_value=1)
    monkeypatch.setattr(main.liveness_mgr.redis, "exists", exists)
    assert asyncio.run(main._is_revoked(f"mock-acme.{UUID}")) is True
    exists.assert_awaited_once_with(f"agent:revoked:{UUID}")
    assert asyncio.run(main._is_revoked("garbage")) is False  # malformed CN: nothing to look up
    exists.side_effect = RuntimeError("redis down")
    assert asyncio.run(main._is_revoked(f"mock-acme.{UUID}")) is False  # fails open (ponytail)
