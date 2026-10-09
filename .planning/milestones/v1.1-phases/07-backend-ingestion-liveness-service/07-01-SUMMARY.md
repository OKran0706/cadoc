---
one_liner: Implemented unified FastAPI ingestion service with non-blocking Kafka routing and mTLS verification.
status: complete
---

# 07-01 Summary: Unified Ingestion Service

## What Was Built
- **FastAPI Ingestion Service**: Replaced `/heartbeat` with unified `/ingest` endpoint for all Sentinel telemetry.
- **Non-Blocking Architecture**: Uses `BackgroundTasks` and `aiokafka` for async Kafka production - ingestion never blocks on downstream delivery.
- **mTLS + Signature Verification**: Verifies Ed25519 signatures on heartbeats with anti-replay timestamp windows.
- **Redis Liveness Tracking**: Updates `sentinel:<id>` TTL on valid heartbeats (90-second TTL for 30-second interval).

## Key Decisions
- **FastAPI over Go**: Python chosen for rapid iteration and existing team familiarity.
- **aiokafka**: Async producer selected to avoid blocking the ingestion path.
- **Log-and-Drop**: Agent drops events if ingestion is unreachable (no local buffering).

## Self-Check: PASSED
- [x] `/ingest` endpoint handles both heartbeats and events
- [x] BackgroundTasks used for Kafka dispatch
- [x] mTLS verification in place
- [x] Redis TTL updates on valid heartbeat
