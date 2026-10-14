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
import redis
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import serialization
import redis as redis_lib
import secrets
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

def generate_signer_key() -> str:
    """
    Generates a new Ed25519 private key and returns its hex-encoded raw bytes.
    """
    private_key = ed25519.Ed25519PrivateKey.generate()
    # Get the raw 32-byte seed
    key_bytes = private_key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption()
    )
    return key_bytes.hex()


def generate_pki_certificate(company_slug: str, sentinel_id: str) -> dict:
    """
    Generates a new mTLS certificate for a sentinel using Vault's PKI engine.
    The CN follows the format {company_slug}.{sentinel_id}.canary.local.
    """
    vault_client = get_vault_client()
    common_name = f"{company_slug}.{sentinel_id}.canary.local"

    try:
        result = vault_client.secrets.pki.generate_certificate(
            name="sentinel-agent",
            common_name=common_name,
            mount_point="pki"
        )
        return {
            "ca_cert": result['data']['issuing_ca'],
            "client_cert": result['data']['certificate'],
            "client_key": result['data']['private_key']
        }
    except Exception as exc:
        logger.error("PKI_GENERATION_ERROR: identity=%s error=%s", common_name, exc)
        raise HTTPException(status_code=500, detail="Failed to generate dynamic mTLS certificate")


class BootstrapJoinRequest(BaseModel):
    """Body for POST /bootstrap/join."""
    company_slug: str
    sentinel_id: str


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

def check_rbac(jwt_payload: dict, company_slug: str, sentinel_id: str) -> bool:
    """
    Check whether the authenticated user has permission to bootstrap
    the specified sentinel_id for company_slug.
    """
    # TODO: wire to RBAC DB table — query permissions for jwt_payload["sub"]
    #       against (company_slug, sentinel_id) tuple before issuing a join token.
    return True


# ---------------------------------------------------------------------------
# Redis helpers — JTI blacklisting for one-time use enforcement
# ---------------------------------------------------------------------------

def get_redis_client() -> redis_lib.Redis:
    """Return a synchronous Redis client (used only in bootstrap endpoints)."""
    redis_url = os.getenv("REDIS_URL", "redis://redis:6379/0")
    return redis_lib.from_url(redis_url, decode_responses=True)


def _mark_jti_used(jti: str, ttl: int) -> None:
    """
    Record a JTI as consumed in Redis with TTL matching the token's expiry.
    Subsequent calls with the same JTI will be rejected by _assert_jti_unused().
    """
    r = get_redis_client()
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
    r = get_redis_client()
    if r.exists(JTI_REDIS_PREFIX + jti):
        raise HTTPException(
            status_code=403,
            detail="Join token has already been used — request a new one via /bootstrap/join",
        )


# ---------------------------------------------------------------------------
# FIX CR-01: JWT-based Join Token (replaces Vault response-wrapping)
# ---------------------------------------------------------------------------

def mint_join_token(company_slug: str, sentinel_id: str) -> str:
    """
    Issue a signed JWT Join Token that embeds company_slug and sentinel_id.

    The token is signed with BOOTSTRAP_JWT_SECRET (separate from the user-login
    JWT_SECRET to enforce key separation between authentication domains).

    Payload:
        sub  — "sentinel-bootstrap"
        company_slug — the tenant slug
        sentinel_id  — the unique agent name
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
        "company_slug": company_slug,
        "sentinel_id": sentinel_id,
        "jti": jti,
        "iat": now,
        "exp": now + JOIN_TOKEN_TTL_SECONDS,
    }

    token: str = jwt.encode(payload, secret, algorithm=BOOTSTRAP_JWT_ALGORITHM)
    logger.info(
        "JOIN_TOKEN_ISSUED: company_slug=%s sentinel_id=%s jti=%s",
        company_slug, sentinel_id, jti,
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

    for required in ("company_slug", "sentinel_id", "jti"):
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


def fetch_sentinel_credentials(join_token: str, client_id: str = "", source_ip: str = "unknown") -> dict:
    """
    Validate the Join Token JWT, enforce one-time use via Redis JTI blacklisting,
    then fetch the Sentinel's mTLS credential package from Vault PKI.

    FIX CR-01: Identity is now extracted from the JWT payload directly.
    """
    # Step 1: Verify and decode the Join Token JWT.
    payload = decode_join_token(join_token)
    company_slug: str = payload["company_slug"]
    sentinel_id: str = payload["sentinel_id"]
    jti: str = payload["jti"]
    exp: int = payload["exp"]

    import time
    remaining_ttl = max(1, exp - int(time.time()))

    # Step 2: Enforce one-time use — atomically mark JTI as consumed.
    _mark_jti_used(jti, ttl=remaining_ttl)

    # Step 2.1: Generate the Ratcheting Renewal Token
    renewal_token = secrets.token_hex(32)

    logger.info(
        "BOOTSTRAP_CRED_REQUEST: identity=%s.%s jti=%s",
        company_slug, sentinel_id, jti,
    )

    # Step 3: Generate dynamic mTLS credentials and Signer Key (Brokered)
    pki_creds = generate_pki_certificate(company_slug, sentinel_id)
    signer_key = generate_signer_key()

    # Store the Renewal Token and Signer Key in Vault
    # Path is scoped by company_slug to ensure multi-tenant isolation in KV
    identity_path = f"canary/tenants/{company_slug}/sentinels/{sentinel_id}/identity"
    try:
        vault_client = get_vault_client()
        vault_client.secrets.kv.v2.create_or_update_secret(
            path=identity_path,
            secret={
                "current_token": renewal_token,
                "previous_token": None,
                "signer_key": signer_key
            },
            mount_point="secret",
        )
    except Exception as exc:
        logger.error("BOOTSTRAP_TOKEN_STORE_ERROR: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to store renewal assets in Vault")

    ca_cert = pki_creds["ca_cert"]
    client_cert = pki_creds["client_cert"]
    client_key = pki_creds["client_key"]

    logger.info(
        "BOOTSTRAP_CREDS_ISSUED: identity=%s.%s pki=dynamic",
        company_slug, sentinel_id,
    )
    return {
        "ca_cert": ca_cert,
        "client_cert": client_cert,
        "client_key": client_key,
        "renewal_token": renewal_token,
        "signer_key": signer_key,
    }


def fetch_sentinel_credentials_by_client_id(client_id: str, is_retry: bool = False) -> dict:
    """
    Generate dynamic mTLS credentials and manage renewal tokens.
    Used by the /bootstrap/renew_credentials endpoint.

    Identity (client_id) format expected: {company_slug}.{sentinel_id}
    """
    from fastapi import HTTPException

    # Split the composite ID
    parts = client_id.split(".", 1)
    if len(parts) != 2:
        raise HTTPException(status_code=400, detail="Invalid client_id format - expected {company_slug}.{sentinel_id}")

    company_slug, sentinel_id = parts

    vault_client = get_vault_client()
    token_path = f"canary/tenants/{company_slug}/sentinels/{sentinel_id}/identity"

    try:
        # 1. Read existing token state to handle ratchet/recovery
        token_secret = vault_client.secrets.kv.v2.read_secret_version(
            path=token_path, mount_point="secret"
        )
        token_data = token_secret["data"]["data"]
        current_token = token_data.get("current_token")
        signer_key = token_data.get("signer_key")

        # Always issue a fresh cert on renewal
        pki_creds = generate_pki_certificate(company_slug, sentinel_id)

    except hvac.exceptions.InvalidPath:
        logger.warning("RENEW_TOKEN_NOT_FOUND: path=secret/data/%s", token_path)
        raise HTTPException(status_code=404, detail="Sentinel identity record not found")
    except Exception as exc:
        logger.error("RENEW_TOKEN_READ_ERROR: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to read token state for ratchet")

    if is_retry:
        # RECOVERY: The client sent the previous token. We resend the SAME current token and signer key.
        logger.info("RENEW_RECOVERY: identity=%s.%s using previous token. Resending current assets.", company_slug, sentinel_id)
        effective_token = current_token
        effective_signer_key = signer_key
    else:
        # RATCHET: Move current -> previous, generate new current and new signer key
        effective_token = secrets.token_hex(32)
        effective_signer_key = generate_signer_key()
        try:
            vault_client.secrets.kv.v2.create_or_update_secret(
                path=token_path,
                secret={
                    "current_token": effective_token,
                    "previous_token": current_token,
                    "signer_key": effective_signer_key
                },
                mount_point="secret",
            )
        except Exception as exc:
            logger.error("RENEW_TOKEN_STORE_ERROR: %s", exc)
            raise HTTPException(status_code=500, detail="Failed to ratchet renewal assets in Vault")

    logger.info(
        "RENEW_CREDS_ISSUED: identity=%s.%s pki=dynamic retry=%s",
        company_slug, sentinel_id, is_retry
    )
    return {
        "ca_cert": pki_creds["ca_cert"],
        "client_cert": pki_creds["client_cert"],
        "client_key": pki_creds["client_key"],
        "renewal_token": effective_token,
        "signer_key": effective_signer_key,
    }
