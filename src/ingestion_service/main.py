import logging
import os
import json
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException, BackgroundTasks
from pydantic import BaseModel
from aiokafka import AIOKafkaProducer

from crypto import verify_signature, verify_timestamp
from liveness import LivenessManager

# Configuration
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
KAFKA_BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
KAFKA_TOPIC = os.getenv("KAFKA_TOPIC", "canary-events")
ORG_PUBLIC_KEY = os.getenv("ORG_PUBLIC_KEY", "") # Placeholder if not set

# Initialization
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ingestion")
liveness_mgr = LivenessManager(REDIS_URL)

class IngestionState:
    producer: AIOKafkaProducer = None

state = IngestionState()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize Kafka Producer
    logger.info(f"STARTUP: Connecting to Kafka at {KAFKA_BOOTSTRAP_SERVERS}")
    state.producer = AIOKafkaProducer(bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS)
    await state.producer.start()
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
