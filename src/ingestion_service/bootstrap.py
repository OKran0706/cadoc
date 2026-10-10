# canary-system/src/ingestion_service/bootstrap.py
# Brokered identity bootstrapping helpers for the Ingestion Service.
#
# FIX (CR-01): Join Token is now a signed JWT that embeds client_id and server_id.
#   - Eliminates the Vault wrapping-token dependency entirely.
#   - The Ingestion Service signs the JWT with BOOTSTRAP_JWT_SECRET (separate from
#     the user-login JWT_SECRET to enforce key separation).
#   - Redis JTI blacklisting enforces one-time use without Vault round-trips.
#   - fetch_sentinel_credentials() extracts client_id directly from the JWT payload
#     instead of relying on the caller to propagate it.

import logging
import os
import uuid as _uuid_mod

import hvac
import jwt
import redis as redis_lib
from fastapi import HTTPException
from pydantic import BaseModel

logger = logging.getLogger("ingestion.bootstrap")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

JOIN_TOKEN_TTL_SECONDS = 900  # 15 minutes
BOOTSTRAP_JWT_ALGORITHM = "HS256"
JTI_REDIS_PREFIX = "bootstrap:jti:"


# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------

class BootstrapJoinRequest(BaseModel):
    """Body for POST /bootstrap/join."""
    client_id: str
    server_id: str


# ---------------------------------------------------------------------------
# JWT verification — User Login token (proves admin identity)
# ---------------------------------------------------------------------------

def verify_user_jwt(token: str) -> dict:
    """
    Decode and verify a User Login JWT.
    Reads JWT_SECRET from the environment.
    Raises HTTPException on invalid or expired tokens.
    """
    secret = os.getenv("JWT_SECRET", "")
    if not secret:
        raise RuntimeError("JWT_SECRET environment variable is not set")

    try:
        payload = jwt.decode(token, secret, algorithms=[BOOTSTRAP_JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="JWT expired")
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid JWT: {exc}")


# ---------------------------------------------------------------------------
# RBAC
# ---------------------------------------------------------------------------

def check_rbac(jwt_payload: dict, client_id: str, server_id: str) -> bool:
    """
    Check whether the authenticated user has permission to bootstrap
    the specified client_id on server_id.

    # TODO: wire to RBAC DB table — query permissions for jwt_payload["sub"]
    #       against (client_id, server_id) tuple before issuing a join token.
    """
    return True


# ---------------------------------------------------------------------------
# Redis helpers — JTI blacklisting for one-time use enforcement
# ---------------------------------------------------------------------------

def _get_redis() -> redis_lib.Redis:
    """Return a synchronous Redis client (used only in bootstrap endpoints)."""
    redis_url = os.getenv("REDIS_URL", "redis://redis:6379/0")
    return redis_lib.from_url(redis_url, decode_responses=True)


def _mark_jti_used(jti: str, ttl: int) -> None:
    """
    Record a JTI as consumed in Redis with TTL matching the token's expiry.
    Subsequent calls with the same JTI will be rejected by _assert_jti_unused().
    """
    r = _get_redis()
    key = JTI_REDIS_PREFIX + jti
    # SET key 1 EX ttl NX — only set if not already present (atomic guard)
    already_set = not r.set(key, "1", ex=ttl, nx=True)
    if already_set:
        raise HTTPException(
            status_code=403,
            detail="Join token has already been used — request a new one via /bootstrap/join",
        )


def _assert_jti_unused(jti: str) -> None:
    """
    Check that the JTI has not been consumed yet.
    Raises 403 if the JTI is already present in Redis.

    Note: _mark_jti_used() combines the check+set atomically via SET NX.
    This function is kept as a pre-flight read for clarity in the calling code.
    """
    r = _get_redis()
    if r.exists(JTI_REDIS_PREFIX + jti):
        raise HTTPException(
            status_code=403,
            detail="Join token has already been used — request a new one via /bootstrap/join",
        )


# ---------------------------------------------------------------------------
# FIX CR-01: JWT-based Join Token (replaces Vault response-wrapping)
# ---------------------------------------------------------------------------

def mint_join_token(client_id: str, server_id: str) -> str:
    """
    Issue a signed JWT Join Token that embeds client_id and server_id.

    The token is signed with BOOTSTRAP_JWT_SECRET (separate from the user-login
    JWT_SECRET to enforce key separation between authentication domains).

    Payload:
        sub  — "sentinel-bootstrap"
        client_id — the Sentinel client being enrolled
        server_id — the server this Sentinel belongs to
        jti  — unique token ID (used for one-time-use Redis blacklisting)
        exp  — now + 15 minutes

    The token is intentionally stateless: the Ingestion Service does NOT need
    to store it. Validity is enforced by signature + expiry + JTI blacklist.
    """
    secret = os.getenv("BOOTSTRAP_JWT_SECRET", "")
    if not secret:
        raise RuntimeError("BOOTSTRAP_JWT_SECRET environment variable is not set")

    import time
    now = int(time.time())
    jti = str(_uuid_mod.uuid4())

    payload = {
        "sub": "sentinel-bootstrap",
        "client_id": client_id,
        "server_id": server_id,
        "jti": jti,
        "iat": now,
        "exp": now + JOIN_TOKEN_TTL_SECONDS,
    }

    token: str = jwt.encode(payload, secret, algorithm=BOOTSTRAP_JWT_ALGORITHM)
    logger.info(
        "JOIN_TOKEN_ISSUED: client_id=%s server_id=%s jti=%s",
        client_id, server_id, jti,
    )
    return token


def decode_join_token(join_token: str) -> dict:
    """
    Verify and decode a Join Token JWT.
    Validates signature, expiry, and subject claim.
    Raises HTTPException on any failure.
    """
    secret = os.getenv("BOOTSTRAP_JWT_SECRET", "")
    if not secret:
        raise RuntimeError("BOOTSTRAP_JWT_SECRET environment variable is not set")

    try:
        payload = jwt.decode(join_token, secret, algorithms=[BOOTSTRAP_JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=403, detail="Join token has expired — request a new one via /bootstrap/join")
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=403, detail=f"Invalid join token: {exc}")

    if payload.get("sub") != "sentinel-bootstrap":
        raise HTTPException(status_code=403, detail="Token is not a valid join token")

    for required in ("client_id", "server_id", "jti"):
        if not payload.get(required):
            raise HTTPException(status_code=403, detail=f"Join token missing required claim: {required}")

    return payload


# ---------------------------------------------------------------------------
# Vault helpers — credential fetching
# ---------------------------------------------------------------------------

def get_vault_client() -> hvac.Client:
    """Return a configured hvac Vault client using admin credentials."""
    vault_addr = os.getenv("VAULT_ADDR", "http://127.0.0.1:8200")
    admin_token = os.getenv("VAULT_ADMIN_TOKEN", "")
    return hvac.Client(url=vault_addr, token=admin_token)


def fetch_sentinel_credentials(join_token: str, client_id: str = "") -> dict:
    """
    Validate the Join Token JWT, enforce one-time use via Redis JTI blacklisting,
    then fetch the Sentinel's mTLS credential package from Vault KV.

    FIX CR-01: client_id is now extracted from the JWT payload directly,
    eliminating the need for the caller to pass it separately.

    Returns {"ca_cert": "...", "client_cert": "...", "client_key": "..."}

    The Ingestion Service does NOT persist client_key — it is returned
    directly to the Sentinel which keeps it in memory only.
    """
    # Step 1: Verify and decode the Join Token JWT.
    payload = decode_join_token(join_token)
    resolved_client_id: str = payload["client_id"]
    jti: str = payload["jti"]
    exp: int = payload["exp"]

    import time
    remaining_ttl = max(1, exp - int(time.time()))

    # Step 2: Enforce one-time use — atomically mark JTI as consumed.
    # This is the primary replay-attack defence.
    _mark_jti_used(jti, ttl=remaining_ttl)

    logger.info(
        "BOOTSTRAP_CRED_REQUEST: client_id=%s jti=%s",
        resolved_client_id, jti,
    )

    # Step 3: Fetch the mTLS credential package from Vault KV using admin token.
    vault_client = get_vault_client()
    kv_path = f"canary/sentinels/{resolved_client_id}"

    try:
        secret = vault_client.secrets.kv.v2.read_secret_version(
            path=kv_path, mount_point="secret"
        )
        data: dict = secret["data"]["data"]
    except hvac.exceptions.InvalidPath:
        logger.warning("BOOTSTRAP_KV_NOT_FOUND: path=secret/data/%s", kv_path)
        raise HTTPException(
            status_code=404,
            detail=f"Sentinel credentials not found at secret/{kv_path}",
        )
    except Exception as exc:
        logger.error("BOOTSTRAP_KV_ERROR: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to read credentials from Vault")

    ca_cert = data.get("ca_cert", "")
    client_cert = data.get("client_cert", "")
    client_key = data.get("client_key", "")

    if not ca_cert or not client_cert or not client_key:
        logger.error("BOOTSTRAP_INCOMPLETE_CREDS: path=secret/data/%s", kv_path)
        raise HTTPException(status_code=500, detail="Incomplete credential package in Vault")

    logger.info(
        "BOOTSTRAP_CREDS_ISSUED: client_id=%s path=secret/data/%s",
        resolved_client_id, kv_path,
    )
    return {
        "ca_cert": ca_cert,
        "client_cert": client_cert,
        "client_key": client_key,
    }


def fetch_sentinel_credentials_by_client_id(client_id: str) -> dict:
    """
    Fetch the mTLS credential package from Vault KV using the client_id directly.
    Used by the /bootstrap/renew_credentials endpoint where the client identity
    is already asserted via mTLS — no join token is involved.

    Returns {"ca_cert": "...", "client_cert": "...", "client_key": "..."}
    """
    from fastapi import HTTPException

    vault_client = get_vault_client()
    kv_path = f"canary/sentinels/{client_id}"

    try:
        secret = vault_client.secrets.kv.v2.read_secret_version(
            path=kv_path, mount_point="secret"
        )
        data: dict = secret["data"]["data"]
    except hvac.exceptions.InvalidPath:
        logger.warning("RENEW_KV_NOT_FOUND: path=secret/data/%s", kv_path)
        raise HTTPException(
            status_code=404,
            detail=f"Sentinel credentials not found at secret/{kv_path}",
        )
    except Exception as exc:
        logger.error("RENEW_KV_ERROR: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to read credentials from Vault")

    ca_cert = data.get("ca_cert", "")
    client_cert = data.get("client_cert", "")
    client_key = data.get("client_key", "")

    if not ca_cert or not client_cert or not client_key:
        logger.error("RENEW_INCOMPLETE_CREDS: path=secret/data/%s", kv_path)
        raise HTTPException(status_code=500, detail="Incomplete credential package in Vault")

    logger.info(
        "RENEW_CREDS_ISSUED: client_id=%s path=secret/data/%s",
        client_id, kv_path,
    )
    return {
        "ca_cert": ca_cert,
        "client_cert": client_cert,
        "client_key": client_key,
    }
