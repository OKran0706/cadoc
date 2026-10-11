import logging
import os
import json
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException, BackgroundTasks, Header
from pydantic import BaseModel
from aiokafka import AIOKafkaProducer

from crypto import verify_signature, verify_timestamp
from liveness import LivenessManager
from bootstrap import (
    BootstrapJoinRequest,
    verify_user_jwt,
    check_rbac,
    mint_join_token,
    fetch_sentinel_credentials,
    fetch_sentinel_credentials_by_client_id,
    decode_join_token,
    get_redis_client,
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
async def handle_ingest(envelope: IngestEnvelope, background_tasks: BackgroundTasks):
    """
    Unified ingestion endpoint for all Sentinel telemetry.
    """
    # 1. Verification Logic
    try:
        payload_data = json.loads(envelope.payload)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    sentinel_id = payload_data.get("id", envelope.key_id)
    sentinel_ts = payload_data.get("ts")
    event_type = payload_data.get("type", "UNKNOWN")

    # Time-window protection (Anti-replay)
    if not verify_timestamp(sentinel_ts):
        logger.warning(f"REPLAY_ATTACK: Expired timestamp from {sentinel_id}")
        raise HTTPException(status_code=403, detail="Timestamp out of window")

    # Signature verification (Unified trust anchor per D-17)
    if ORG_PUBLIC_KEY:
        if not verify_signature(ORG_PUBLIC_KEY, envelope.signature, envelope.payload):
            logger.warning(f"BAD_SIGNATURE: Invalid signature for {sentinel_id}")
            raise HTTPException(status_code=403, detail="Invalid signature")

    # 2. Unified Routing
    if event_type == "SENTINEL_HEARTBEAT":
        # Synchronous-path update (Redis is low latency)
        await liveness_mgr.update_liveness(sentinel_id, envelope.payload)
        logger.info(f"HEARTBEAT_INGESTED: {sentinel_id}")
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
    if not check_rbac(jwt_payload, request.client_id, request.server_id):
        raise HTTPException(status_code=403, detail="Insufficient permissions to bootstrap this sentinel")
    join_token = mint_join_token(request.client_id, request.server_id)
    logger.info(
        "BOOTSTRAP_JOIN: issued join token for client=%s server=%s user=%s",
        request.client_id, request.server_id, jwt_payload.get("sub"),
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
    client_id = request.headers.get("X-Client-Cert-CN", "")
    provided_token = request.headers.get("X-Renewal-Token", "")
    source_ip = request.client.host if request.client else "unknown"

    if not client_id:
        logger.warning("RENEW_NO_CLIENT_CN: IP=%s", source_ip)
        raise HTTPException(status_code=401, detail="Client identity could not be determined")

    if not provided_token:
        logger.error("RENEW_MISSING_TOKEN: client_id=%s IP=%s", client_id, source_ip)
        raise HTTPException(status_code=400, detail="Missing X-Renewal-Token header")

    # 2. Ratchet Token Check
    r = get_redis_client()
    expected_token = r.get(f"sentinel:renewal_token:{client_id}")

    if not expected_token:
        # Token doesn't exist in Redis — Sentinel needs a full re-bootstrap
        logger.error("RENEW_NO_TOKEN_IN_REDIS: client_id=%s", client_id)
        raise HTTPException(status_code=403, detail="No active session found. Re-bootstrap required.")

    if provided_token != expected_token:
        # SECURITY ALARM: The provided token does not match the active session.
        # This indicates either a desync or an active replay/theft attempt.
        logger.critical(
            "SECURITY_ALARM: Invalid ratcheting token for client_id=%s! "
            "Expected: %s..., Provided: %s..., SourceIP: %s. "
            "Possible theft or replay attack detected!",
            client_id, expected_token[:8], provided_token[:8], source_ip
        )
        raise HTTPException(status_code=403, detail="Invalid renewal token. Request blocked.")

    logger.info("BOOTSTRAP_RENEW_SUCCESS: client_id=%s from %s", client_id, source_ip)
    credentials = fetch_sentinel_credentials_by_client_id(client_id)
    return credentials
