# Plan: 07-02 — Sentinel-A Unified Telemetry Migration

Decouple the Sentinel Go agent from Kafka and migrate all telemetry to the unified mTLS ingestion service.

## Proposed Changes

### Go Agent
#### [MODIFY] [src/sentinel/cmd/sentinel-a/main.go](file:///c:/Users/Karan/Desktop/canary/cadoc/src/sentinel/cmd/sentinel-a/main.go)
- **Remove** imports: `github.com/segmentio/kafka-go`.
- **Remove** global state: `writer *kafka.Writer`.
- **Implement IngestClient**: A simple wrapper around `http.Client` that handles POST to `IngestionURL` with mTLS.
- **Reroute**:
    - `main` loop Proof events.
    - `selfmon` events.
    - Heartbeat loops.
    - `pollKillSwitch` reports.

#### [MODIFY] [src/sentinel/internal/selfmon/selfmon.go](file:///c:/Users/Karan/Desktop/canary/cadoc/src/sentinel/internal/selfmon/selfmon.go)
- Update function signatures to take an `IngestClient` or generic `Sender` interface instead of `*kafka.Writer`.

## Verification Plan
- **Build Build**: Ensure Go code compiles without any Kafka references.
- **Test Ingestion**: Run a local FastAPI instance and verify that Sentinel-A successfully sends integrity events and heartbeats to the unified endpoint.
