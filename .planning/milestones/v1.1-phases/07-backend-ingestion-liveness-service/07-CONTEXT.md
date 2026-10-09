# Phase 07: Backend Ingestion & Liveness Service - Context

**Gathered:** 2026-04-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Build a stateless, horizontally scalable backend ingestion layer for both heartbeats and events. All Sentinel telemetry must flow through this service via mTLS. The service decouples the agents from Kafka and ensures non-blocking delivery to downstream systems.

</domain>

<decisions>
## Implementation Decisions

### Service Framework & Language
- **D-01**: The Ingestion Service must be implemented using **FastAPI** (Python).
- **D-02**: The service will be a standalone backend component running parallel to the existing Kafka infrastructure.

### Security & Verification
- **D-03**: **mTLS** is required for all incoming heartbeats (identity verification). Identity should be traced back to the Project CA.
- **D-04**: **Ed25519 signatures** must be verified for the heartbeat payload (authenticity).
- **D-05**: **Anti-replay protection** must be implemented using encoded timestamps (verified against a sliding window).

### Liveness Tracking (Redis)
- **D-06**: **Redis** is the canonical source of truth for sentinel liveness.
- **D-07**: On a valid heartbeat, the service updates `sentinel:<id>` with the full payload.
- **D-08**: **TTL Strategy**: Use a **90-second TTL** (1.5 minutes) for a 30-second heartbeat interval (3x multiplier).

### Failure Detection
- **D-09**: **Failure detection is removed** from this service. A separate CRONJOB system will monitor Redis expirations later.
- **D-10**: The service focuses solely on the **synchronous ingestion path** and updating Redis TTLs.

### Unified Ingestion & Non-Blocking Routing
- **D-11**: ALL Sentinel events (heartbeats, capability proofs, integrity events) must be routed to the Ingestion Service's `POST /ingest` endpoint.
- **D-12**: The direct Kafka connection in Sentinel agents must be **removed**.
- **D-13**: The Ingestion Service must NOT block on downstream delivery. Use **FastAPI BackgroundTasks** and **aiokafka** for asynchronous Kafka production.
- **D-14**: The service must be **horizontally scalable**.
- **D-15**: **NGINX** will act as the load balancer. 
- **D-16**: **Agent Resilience**: If the Ingestion Service is unreachable, the Sentinel agent will **log and drop** the event (no local buffering).
- **D-17**: **Key Management**: Use **1 public key** for signature verification (or trust the mTLS certificate identity). Decisions on key distribution are simplified to a single trust anchor.

### The Agent's Discretion
- Choice of Python Ed25519 library (e.g., PyNaCl).
- Implementation details of the Redis PubSub listener goroutine/thread.
- Directory structure for the ingestion service within `src/`.

</decisions>

<canonical_refs>
## Canonical References

### Project Requirements
- `REQUIREMENTS.md` §ING-01..02, LIV-01..02 — Functional requirements for ingestion and liveness.

### Cryptographic Patterns
- `src/sentinel/internal/auth/ticket.go` — Reference for Ed25519 signature verification logic (used in Go).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/sentinel/internal/sysutil/sysutil.go`: `LoadTLSConfig` logic can be used as a reference for mTLS setup.
- `requirements.txt`: Python environment already exists with `kafka-python`, `PyYAML`, and `jsonschema`.

### Integration Points
- **Sentinel-A**: Heartbeat loop in `src/sentinel/cmd/sentinel-a/main.go` will be the primary client.
- **Redis**: New backend dependency for the ingestion service.

</code_context>

<deferred>
## Deferred Ideas
- Specific backend alerting (OOB/Slack integration) — Phase 08+.
- Advanced payload normalization (normalization rules beyond indexing by ID).

</deferred>

---

*Phase: 07-backend-ingestion-liveness-service*
*Context gathered: 2026-04-21*
