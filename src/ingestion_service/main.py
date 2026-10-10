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
    decode_join_token,
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
    credentials = fetch_sentinel_credentials(join_token, client_id="")
    logger.info("BOOTSTRAP_GET_CREDENTIALS: credentials issued successfully")
    return credentials
