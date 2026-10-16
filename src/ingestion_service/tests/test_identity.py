import os
os.environ.setdefault("JWT_SECRET", "t")
os.environ.setdefault("BOOTSTRAP_JWT_SECRET", "t")

from liveness import parse_agent_cn

UUID = "34d0222e-5f7b-4b7f-b1be-023377ec8f8f"


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
