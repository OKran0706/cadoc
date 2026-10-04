---
one_liner: Migrated Sentinel-A from direct Kafka to unified ingestion service with mTLS HTTP transport.
status: complete
---

# 07-02 Summary: Sentinel-A Unified Telemetry Migration

## What Was Built
- **Removed Kafka Dependency**: Stripped `kafka-go` imports from Sentinel-A main loop.
- **IngestClient**: New HTTP client wrapper for POST requests to ingestion service with mTLS.
- **Rerouted Telemetry**: All integrity events, heartbeats, selfmon, and kill-switch reports now flow through `/ingest`.
- **selfmon.Update**: Updated to accept `IngestClient` instead of `*kafka.Writer`.

## Key Decisions
- **Clean Break**: All Kafka references removed from agent in single migration.
- **mTLS Pass-Through**: Uvicorn handles TLS termination, preserving E2E identity.

## Self-Check: PASSED
- [x] No `kafka-go` imports in cmd/sentinel-a
- [x] IngestClient implemented with mTLS
- [x] All telemetry paths routed to ingestion service
- [x] Build succeeds without Kafka dependencies
