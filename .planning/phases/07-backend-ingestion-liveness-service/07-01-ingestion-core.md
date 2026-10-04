# Plan: 07-01 — Unified Ingestion Service (FastAPI + Kafka Proxy)

Implement a high-performance, non-blocking ingestion service that proxies all Sentinel telemetry to downstream systems (Redis and Kafka).

## Proposed Changes

### Ingestion Service
#### [MODIFY] [src/ingestion_service/requirements.txt](file:///c:/Users/Karan/Desktop/canary/cadoc/src/ingestion_service/requirements.txt)
- Add `aiokafka==0.10.0`.

#### [MODIFY] [src/ingestion_service/main.py](file:///c:/Users/Karan/Desktop/canary/cadoc/src/ingestion_service/main.py)
- **Replace** `/heartbeat` with `/ingest` endpoint.
- **Implement Lifespan**: Manage `AIOKafkaProducer` singleton.
- **Implement Background Routing**:
    - Heartbeats: Verify and Update Redis (sync verify, async update).
    - Events: Verify and dispatch to Kafka via `BackgroundTasks.add_task(kafka_send)`.

#### [MODIFY] [src/ingestion_service/liveness.py](file:///c:/Users/Karan/Desktop/canary/cadoc/src/ingestion_service/liveness.py)
- Update to support receiving full envelope from the unified endpoint.

## Verification Plan
- **Unit Test**: `pytest` for the routing logic.
- **Mock Kafka**: Use a local script to verify the producer sends messages to the `canary-events` topic.
- **Non-blocking check**: Measure response time of `/ingest` while Kafka is under simulated delay.
