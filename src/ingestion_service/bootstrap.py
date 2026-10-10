# canary-system/src/ingestion_service/bootstrap.py
# Brokered identity bootstrapping helpers for the Ingestion Service.
# Provides JWT verification, placeholder RBAC check, and Vault-backed
# credential issuance for the /bootstrap/* endpoints.

import logging
import os

import hvac
import jwt
from fastapi import HTTPException
from pydantic import BaseModel

logger = logging.getLogger("ingestion.bootstrap")


# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------

class BootstrapJoinRequest(BaseModel):
    """Body for POST /bootstrap/join."""
    client_id: str
    server_id: str


# ---------------------------------------------------------------------------
# JWT verification
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
        payload = jwt.decode(token, secret, algorithms=["HS256"])
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
# Vault helpers
# ---------------------------------------------------------------------------

def get_vault_client() -> hvac.Client:
    """Return a configured hvac Vault client using admin credentials."""
    vault_addr = os.getenv("VAULT_ADDR", "http://127.0.0.1:8200")
    admin_token = os.getenv("VAULT_ADMIN_TOKEN", "")
    return hvac.Client(url=vault_addr, token=admin_token)


def mint_join_token(client_id: str, server_id: str) -> str:
    """
    Ask Vault to create a short-lived, response-wrapped bootstrap token.
    The wrapping token (OTP) is returned — the actual credentials are
    never seen by this service.

    Token policy: sentinel-bootstrap (read-only on sentinel KV paths).
    TTL: 15 minutes.  Uses: 2 (one unwrap + one KV read).
    """
    client = get_vault_client()
    try:
        result = client.auth.token.create(
            policies=["sentinel-bootstrap"],
            ttl="15m",
            num_uses=2,
            wrap_ttl="15m",
        )
        wrapping_token: str = result["wrap_info"]["token"]
        logger.info(
            "VAULT_WRAP_ISSUED: client_id=%s server_id=%s", client_id, server_id
        )
        return wrapping_token
    except Exception as exc:
        logger.error("VAULT_WRAP_FAILED: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to issue join token from Vault")


def fetch_sentinel_credentials(join_token: str, client_id: str) -> dict:
    """
    Unwrap the join_token to obtain a short-lived Vault token, then fetch
    the Sentinel's mTLS credential package from KV.

    Returns {"ca_cert": "...", "client_cert": "...", "client_key": "..."}

    The Ingestion Service does NOT persist client_key — it is returned
    directly to the Sentinel which keeps it in memory only.
    """
    vault_addr = os.getenv("VAULT_ADDR", "http://127.0.0.1:8200")

    # Step 1: Unwrap the join token to get the real short-lived token.
    unwrap_client = hvac.Client(url=vault_addr, token=join_token)
    try:
        unwrap_result = unwrap_client.sys.unwrap(token=join_token)
    except hvac.exceptions.Forbidden:
        logger.warning("BOOTSTRAP_UNWRAP_FORBIDDEN: join token rejected (expired or already used)")
        raise HTTPException(status_code=403, detail="Join token invalid, expired, or already consumed")
    except Exception as exc:
        logger.error("BOOTSTRAP_UNWRAP_ERROR: %s", exc)
        raise HTTPException(status_code=500, detail="Vault unwrap failed")

    real_token: str = unwrap_result["auth"]["client_token"]

    # Step 2: Fetch the mTLS credential package using the unwrapped token.
    cred_client = hvac.Client(url=vault_addr, token=real_token)
    kv_path = f"canary/sentinels/{client_id}" if client_id else "canary/sentinels/default"

    try:
        secret = cred_client.secrets.kv.v2.read_secret_version(
            path=kv_path, mount_point="secret"
        )
        data: dict = secret["data"]["data"]
    except hvac.exceptions.InvalidPath:
        logger.warning("BOOTSTRAP_KV_NOT_FOUND: path=secret/data/%s", kv_path)
        raise HTTPException(status_code=404, detail=f"Sentinel credentials not found at secret/{kv_path}")
    except Exception as exc:
        logger.error("BOOTSTRAP_KV_ERROR: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to read credentials from Vault")

    ca_cert = data.get("ca_cert", "")
    client_cert = data.get("client_cert", "")
    client_key = data.get("client_key", "")

    if not ca_cert or not client_cert or not client_key:
        logger.error("BOOTSTRAP_INCOMPLETE_CREDS: path=secret/data/%s", kv_path)
        raise HTTPException(status_code=500, detail="Incomplete credential package in Vault")

    logger.info("BOOTSTRAP_CREDS_ISSUED: path=secret/data/%s", kv_path)
    return {
        "ca_cert": ca_cert,
        "client_cert": client_cert,
        "client_key": client_key,
    }
