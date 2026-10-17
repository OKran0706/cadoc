"""GET /control/canaries: mTLS-authenticated proxy to the platform's internal canary list.

Identity comes only from the verified client-cert CN (nginx headers). Negative cases first.
"""
import os
os.environ.setdefault("JWT_SECRET", "t")
os.environ.setdefault("BOOTSTRAP_JWT_SECRET", "t")

import asyncio
import io
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

SID = "34d0222e-5f7b-4b7f-b1be-023377ec8f8f"
CERT = {"X-Client-Cert-DN": f"CN=mock-acme.{SID}.canary.local"}
TOKEN = "internal-token-0123456789abcdef"


@pytest.fixture(autouse=True)
def env(monkeypatch):
    import main
    monkeypatch.setattr(main, "_is_revoked", AsyncMock(return_value=False))
    monkeypatch.setattr(main, "INTERNAL_API_TOKEN", TOKEN, raising=False)
    monkeypatch.setattr(main, "PLATFORM_URL", "http://platform.test:8000", raising=False)


@pytest.fixture
def platform(monkeypatch):
    import main
    m = MagicMock(return_value={"canaries": []})
    monkeypatch.setattr(main, "_platform_get_canaries", m, raising=False)
    return m


def get(headers=None, params=None):
    import main

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://t") as c:
            return await c.get("/control/canaries", headers=headers or {}, params=params)

    return asyncio.run(go())


def item(**kw):
    d = {"id": str(uuid.uuid4()), "path": "/opt/app/keys/id_rsa.bak", "type": "ssh_key",
         "sha256": "a" * 64, "status": "planted"}
    d.update(kw)
    return d


# ---------------------------------------------------------------- identity: negative

def test_no_client_cert_is_unauthorized(platform):
    assert get().status_code == 401
    platform.assert_not_called()


@pytest.mark.parametrize("cn", ["acme", "acme.", ".id", "acme.id:evil", "a:b.c", "acme.id.extra", "agent:acme"])
def test_malformed_cert_cn_is_forbidden(platform, cn):
    r = get({"X-Client-Cert-DN": f"CN={cn}.canary.local"})
    assert r.status_code == 403
    platform.assert_not_called()


def test_revoked_agent_is_forbidden(platform, monkeypatch):
    import main
    monkeypatch.setattr(main, "_is_revoked", AsyncMock(return_value=True))
    assert get(CERT).status_code == 403
    platform.assert_not_called()


def test_unset_internal_token_fails_closed(platform, monkeypatch):
    import main
    monkeypatch.setattr(main, "INTERNAL_API_TOKEN", "", raising=False)
    assert get(CERT).status_code == 503
    platform.assert_not_called()


def test_query_params_cannot_redirect_to_another_tenant_or_server(platform):
    other = str(uuid.uuid4())
    get(CERT, params={"slug": "victim", "server_id": other, "company_slug": "victim", "id": other})
    platform.assert_called_once_with("mock-acme", SID)


def test_header_spoofing_attempts_do_not_override_cert(platform):
    hdrs = dict(CERT)
    hdrs.update({"X-Company-Slug": "victim", "X-Tenant-Slug": "victim", "X-Server-Id": str(uuid.uuid4())})
    get(hdrs)
    platform.assert_called_once_with("mock-acme", SID)


# ---------------------------------------------------------------- upstream failure: negative

@pytest.mark.parametrize("exc", [RuntimeError("secret-token-abc internal detail"), TimeoutError("timed out"),
                                 ConnectionRefusedError("refused"), json.JSONDecodeError("bad", "x", 0)])
def test_platform_failure_is_502_without_leaks(platform, exc):
    platform.side_effect = exc
    r = get(CERT)
    assert r.status_code == 502
    assert "secret-token-abc" not in r.text and TOKEN not in r.text and "Traceback" not in r.text


@pytest.mark.parametrize("bad", [None, [], "x", 5, {}, {"canaries": None}, {"canaries": "nope"}, {"canaries": {"a": 1}}])
def test_malformed_platform_payload_is_502(platform, bad):
    platform.return_value = bad
    assert get(CERT).status_code == 502


def test_items_missing_required_fields_are_dropped(platform):
    good = item()
    platform.return_value = {"canaries": [good, {"id": "x"}, "garbage", None, 7, {"path": "/p"}]}
    r = get(CERT)
    assert r.status_code == 200
    assert r.json()["canaries"] == [good]


def test_extra_platform_fields_are_not_forwarded(platform):
    platform.return_value = {"canaries": [item(internal_note="hunter2")], "debug": "x"}
    r = get(CERT)
    assert "hunter2" not in r.text and "debug" not in r.text


def test_token_never_in_response(platform):
    platform.return_value = {"canaries": [item()]}
    assert TOKEN not in get(CERT).text


# ---------------------------------------------------------------- outbound request

def _fake_urlopen(payload):
    seen = {}

    def opener(req, timeout=None):
        seen["req"], seen["timeout"] = req, timeout
        resp = MagicMock()
        resp.read.return_value = json.dumps(payload).encode()
        resp.__enter__.return_value = resp
        return resp

    return opener, seen


def test_outbound_request_has_token_path_and_timeout():
    import main
    opener, seen = _fake_urlopen({"canaries": []})
    with patch("urllib.request.urlopen", opener):
        assert main._platform_get_canaries("mock-acme", SID) == {"canaries": []}
    req = seen["req"]
    assert req.full_url == f"http://platform.test:8000/internal/v1/tenants/mock-acme/servers/{SID}/canaries"
    assert req.get_header("X-internal-token") == TOKEN
    assert req.get_method() == "GET"
    assert seen["timeout"] and seen["timeout"] <= 10


def test_outbound_response_size_is_bounded():
    import main
    big = MagicMock()
    big.read.side_effect = lambda n=-1: b"x" * (n if n and n > 0 else 10**9)
    big.__enter__.return_value = big
    with patch("urllib.request.urlopen", return_value=big):
        with pytest.raises(Exception):
            main._platform_get_canaries("mock-acme", SID)


# ---------------------------------------------------------------- positive

def test_proxies_canaries_for_cert_identity(platform):
    a, b = item(), item(status="tampered", path="/opt/app/configs/.env.staging", type="env_file")
    platform.return_value = {"canaries": [a, b]}
    r = get(CERT)
    assert r.status_code == 200
    assert r.json() == {"canaries": [a, b]}
    platform.assert_called_once_with("mock-acme", SID)


def test_non_uuid_sentinel_id_maps_to_stable_uuid5(platform):
    import main
    r = get({"X-Client-Cert-DN": "CN=mock-acme.edge-01.canary.local"})
    assert r.status_code == 200
    platform.assert_called_once_with("mock-acme", main._agent_uuid("edge-01"))
