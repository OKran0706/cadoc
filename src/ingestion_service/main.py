import logging
import os
import json
import asyncio
import re
from contextlib import asynccontextmanager
import hvac

from fastapi import FastAPI, Request, HTTPException, BackgroundTasks, Header
from pydantic import BaseModel
from aiokafka import AIOKafkaProducer

from crypto import verify_signature, verify_timestamp
from liveness import LivenessManager, parse_agent_cn
from bootstrap import (
    BootstrapJoinRequest,
    verify_user_jwt,
    check_rbac,
    mint_join_token,
    fetch_sentinel_credentials,
    fetch_sentinel_credentials_by_client_id,
    decode_join_token,
    get_redis_client,
    get_vault_client,
)

# Configuration
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
KAFKA_BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
KAFKA_TOPIC = os.getenv("KAFKA_TOPIC", "canary-events")
ORG_PUBLIC_KEY = os.getenv("ORG_PUBLIC_KEY", "")  # Placeholder if not set
VAULT_ADDR = os.getenv("VAULT_ADDR", "http://127.0.0.1:8200")
VAULT_ADMIN_TOKEN = os.getenv("VAULT_ADMIN_TOKEN", "")
JWT_SECRET = os.getenv("JWT_SECRET", "")
# Separate secret for signing Bootstrap Join Tokens (key separation from user JWTs)
BOOTSTRAP_JWT_SECRET = os.getenv("BOOTSTRAP_JWT_SECRET", "")

# Initialization
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ingestion")
liveness_mgr = LivenessManager(REDIS_URL)

class IngestionState:
    producer: AIOKafkaProducer = None

state = IngestionState()


def _extract_client_id(request: Request) -> str:
    """
    Resolve Sentinel identity from trusted proxy headers.
    """
    subject_dn = (
        request.headers.get("X-Client-Cert-DN", "").strip()
        or request.headers.get("X-SSL-Client-S-DN", "").strip()
    )
    cn = ""
    if subject_dn:
        match = re.search(r"CN\s*=\s*([^,/]+)", subject_dn)
        if match:
            cn = match.group(1).strip()

    if not cn:
        cn = request.headers.get("X-Client-Cert-CN", "").strip()

    if cn and cn.endswith(".canary.local"):
        cn = cn.removesuffix(".canary.local")
    return cn

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize Kafka Producer with retries
    if os.getenv("SKIP_KAFKA", "false").lower() != "true":
        logger.info(f"STARTUP: Connecting to Kafka at {KAFKA_BOOTSTRAP_SERVERS}")
        state.producer = AIOKafkaProducer(bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS)
        
        for i in range(10):
            try:
                await state.producer.start()
                logger.info("KAFKA_CONNECTED: Successfully bootstrapped")
                break # Success
            except Exception as e:
                logger.warning(f"KAFKA_CONNECTION_RETRY ({i+1}/10): {e}")
                await asyncio.sleep(5)
        else:
            logger.error("KAFKA_BOOTSTRAP_FAILED: Max retries exceeded")
            raise RuntimeError("Could not connect to Kafka after multiple retries")
    else:
        logger.info("STARTUP: Skipping Kafka initialization (SKIP_KAFKA=true)")
    yield
    # Shutdown: Cleanup
    logger.info("SHUTDOWN: Closing connections")
    await state.producer.stop()
    await liveness_mgr.close()

app = FastAPI(title="Sentinel Unified Ingestion Service", lifespan=lifespan)

@app.get("/health", status_code=200)
async def health_check():
    return {"status": "healthy"}

class IngestEnvelope(BaseModel):
    payload: str     # Raw canonical JSON string from Sentinel
    signature: str   # Hex-encoded Ed25519 signature
    key_id: str      # Public key fingerprint
    hash: str        # Payload hash

async def forward_to_kafka(topic: str, value: str):
    """
    Background task to forward verified event to Kafka.
    """
    try:
        if state.producer:
            await state.producer.send_and_wait(topic, value.encode("utf-8"))
            logger.debug(f"KAFKA_FORWARD_SUCCESS: topic={topic}")
    except Exception as e:
        logger.error(f"KAFKA_FORWARD_FAILED: {e}")

@app.post("/ingest", status_code=202)
async def handle_ingest(
    envelope: IngestEnvelope,
    background_tasks: BackgroundTasks,
    request: Request,
):
    """
    Unified ingestion endpoint for all Sentinel telemetry.
    """
    # 1. Verification Logic
    try:
        payload_data = json.loads(envelope.payload)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    # An agent may only speak as itself: a claimed payload id must equal the identity
    # nginx verified from the client cert ({slug}.{sentinel_id}). Events without an id are unaffected.
    claimed_id = payload_data.get("id")
    cert_id = _extract_client_id(request)
    if claimed_id is not None and claimed_id != cert_id:
        logger.warning(f"IDENTITY_MISMATCH: payload id={claimed_id!r} cert={cert_id!r}")
        raise HTTPException(status_code=403, detail="Payload identity does not match client certificate")

    sentinel_id = payload_data.get("id", envelope.key_id)
    sentinel_ts = payload_data.get("ts")
    event_type = payload_data.get("type", "UNKNOWN")

    # Time-window protection (Anti-replay)
    if not verify_timestamp(sentinel_ts):
        logger.warning(f"REPLAY_ATTACK: Expired timestamp from {sentinel_id}")
        raise HTTPException(status_code=403, detail="Timestamp out of window")

    # Signature verification (Unified trust anchor per D-17)
    # ponytail: signatures are NOT verified unless ORG_PUBLIC_KEY is set, and agents sign with
    # per-agent broker-issued keys, so a single org key can't verify them. Upgrade path: store each
    # agent's public key in Vault at enrollment/renewal and verify against {slug}.{id}'s key (current+previous).
    if ORG_PUBLIC_KEY:
        if not verify_signature(ORG_PUBLIC_KEY, envelope.signature, envelope.payload):
            logger.warning(f"BAD_SIGNATURE: Invalid signature for {sentinel_id}")
            raise HTTPException(status_code=403, detail="Invalid signature")

    # 2. Unified Routing
    if event_type == "SENTINEL_HEARTBEAT":
        # Cryptographic CN-based tenant and identity extraction (No fallbacks!)
        client_cn = _extract_client_id(request)
        identity = parse_agent_cn(client_cn)
        if not identity:
            logger.error(f"CERTIFICATE_CN_MALFORMED: Expected {{slug}}.{{id}}, got CN={client_cn}")
            raise HTTPException(status_code=403, detail="Bad credentials — invalid certificate format")

        company_slug, resolved_sentinel_id = identity

        import uuid
        try:
            uuid.UUID(resolved_sentinel_id)
        except ValueError:
            resolved_sentinel_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, resolved_sentinel_id))

        # Synchronous-path update (Redis is low latency)
        await liveness_mgr.update_liveness(resolved_sentinel_id, envelope.payload, company_slug=company_slug)
        logger.info(f"HEARTBEAT_INGESTED: {company_slug}/{resolved_sentinel_id}")
    else:
        # Asynchronous-path forwarding (Kafka)
        background_tasks.add_task(forward_to_kafka, KAFKA_TOPIC, envelope.payload)
        logger.info(f"EVENT_QUEUED: type={event_type} sentinel={sentinel_id}")

    return {"status": "accepted", "type": event_type}

@app.get("/health")
def health():
    return {"status": "ok", "kafka_connected": state.producer is not None}


# ---------------------------------------------------------------------------
# Bootstrap endpoints — Sentinel identity issuance
# ---------------------------------------------------------------------------

@app.post("/bootstrap/join", status_code=200)
async def bootstrap_join(
    request: BootstrapJoinRequest,
    authorization: str = Header(default=""),
):
    """
    Protected endpoint: issues a 15-min one-time Join Token for Sentinel bootstrapping.
    Requires a valid User Login JWT in Authorization: Bearer <jwt>.
    RBAC check validates the user's permission to bootstrap client_id on server_id.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    user_token = authorization.removeprefix("Bearer ")
    jwt_payload = verify_user_jwt(user_token)
    if not check_rbac(jwt_payload, request.company_slug, request.sentinel_id):
        raise HTTPException(status_code=403, detail="Insufficient permissions to bootstrap this sentinel")
    join_token = mint_join_token(request.company_slug, request.sentinel_id)
    logger.info(
        "BOOTSTRAP_JOIN: issued join token for client=%s server=%s user=%s",
        request.company_slug, request.sentinel_id, jwt_payload.get("sub"),
    )
    return {"join_token": join_token, "expires_in": 900}


@app.post("/bootstrap/get_credentials", status_code=200)
async def bootstrap_get_credentials(
    request: Request,
    authorization: str = Header(default=""),
):
    """
    Semi-protected endpoint: exchanges a Join Token for mTLS credentials.
    Authorization: Bearer <join_token>
    Returns ca_cert, client_cert, client_key as JSON.
    The join token is one-time-use — subsequent calls with the same token return 403.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer join token")
    join_token = authorization.removeprefix("Bearer ")
    source_ip = request.client.host if request.client else "unknown"
    credentials = fetch_sentinel_credentials(join_token, client_id="", source_ip=source_ip)
    logger.info("BOOTSTRAP_GET_CREDENTIALS: credentials issued successfully")
    return credentials


@app.get("/bootstrap/renew_credentials", status_code=200)
async def bootstrap_renew_credentials(
    request: Request,
):
    """
    mTLS-authenticated renewal endpoint for Sentinels.
    Identity is asserted by the client certificate CN (client_id).
    RATCHET: Requires the 'X-Renewal-Token' header matching the current
    valid token in Redis. Upon success, a new token is generated.
    """
    client_id = _extract_client_id(request)
    provided_token = request.headers.get("X-Renewal-Token", "")
    source_ip = request.client.host if request.client else "unknown"

    if not client_id:
        logger.warning("RENEW_NO_CLIENT_CN: IP=%s", source_ip)
        raise HTTPException(status_code=401, detail="Client identity could not be determined")

    if not provided_token:
        logger.error("RENEW_MISSING_TOKEN: client_id=%s IP=%s", client_id, source_ip)
        raise HTTPException(status_code=400, detail="Missing X-Renewal-Token header")

    # 2. Ratchet Token Check (from Vault)
    vault_client = get_vault_client()
    parts = client_id.split(".", 1)
    if len(parts) == 2:
        company_slug, sentinel_id = parts
        kv_path = f"canary/tenants/{company_slug}/sentinels/{sentinel_id}/identity"
    else:
        kv_path = f"canary/sentinels/{client_id}/identity"
    current_expected = None
    previous_expected = None

    try:
        secret = vault_client.secrets.kv.v2.read_secret_version(
            path=kv_path, mount_point="secret"
        )
        data = secret["data"]["data"]
        current_expected = data.get("current_token")
        previous_expected = data.get("previous_token")
    except hvac.exceptions.InvalidPath:
        logger.error("RENEW_NO_TOKEN_IN_VAULT: client_id=%s", client_id)
        raise HTTPException(status_code=403, detail="No active session found. Re-bootstrap required.")
    except Exception as exc:
        logger.error("RENEW_VAULT_ERROR: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to read session state")

    is_retry = False
    if provided_token == current_expected:
        is_retry = False
    elif provided_token == previous_expected and previous_expected is not None:
        is_retry = True
    else:
        # SECURITY ALARM: Neither token matches.
        logger.critical(
            "SECURITY_ALARM: Invalid ratcheting token for client_id=%s! "
            "Provided: %s..., SourceIP: %s. "
            "Possible theft or replay attack detected!",
            client_id, provided_token[:8], source_ip
        )
        raise HTTPException(status_code=403, detail="Invalid renewal token. Request blocked.")

    logger.info("BOOTSTRAP_RENEW_SUCCESS: client_id=%s from %s (retry=%s)", client_id, source_ip, is_retry)
    credentials = fetch_sentinel_credentials_by_client_id(client_id, is_retry=is_retry)
    return credentials


@app.get("/bootstrap/maintenance_key")
async def get_maintenance_key(request: Request):
    """
    Returns the public key used for verifying maintenance tickets.
    Brokered from Vault.
    """
    client_id = _extract_client_id(request) or "unknown"
    vault_client = get_vault_client()
    try:
        # Maintenance pubkey is global (not per-client)
        secret = vault_client.secrets.kv.v2.read_secret_version(
            path="canary/maintenance", mount_point="secret"
        )
        pubkey = secret["data"]["data"].get("cert") or secret["data"]["data"].get("pubkey")
        if not pubkey:
            raise ValueError("Maintenance key not found in Vault")
        
        logger.info("MAINTENANCE_KEY_FETCH: client_id=%s", client_id)
        return {"pubkey": pubkey}
    except Exception as exc:
        logger.error("MAINTENANCE_KEY_ERROR: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to fetch maintenance key")


@app.get("/control/killswitch")
async def get_killswitch(request: Request):
    """
    Returns the current signed killswitch ticket if active.
    Brokered from Vault.
    """
    client_id = _extract_client_id(request) or "unknown"
    vault_client = get_vault_client()
    try:
        # Killswitch ticket is global (not per-client)
        secret = vault_client.secrets.kv.v2.read_secret_version(
            path="canary/control", mount_point="secret"
        )
        ticket = secret["data"]["data"].get("killswitch_ticket")
        
        logger.info("KILLSWITCH_TICKET_FETCH: client_id=%s found=%s", client_id, bool(ticket))
        return {"ticket": ticket}
    except hvac.exceptions.InvalidPath:
        # No control path — this is normal if no killswitch was ever issued
        return {"ticket": None}
    except Exception as exc:
        logger.error("KILLSWITCH_FETCH_ERROR: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to fetch killswitch state")
