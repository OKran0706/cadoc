# Testing Strategy

## Local Environment
- A comprehensive local testing environment exists via `docker-compose.yml` in the repository root.
- It spins up a full pipeline: Zookeeper, Kafka, Postgres, MySQL, Redis, Detection Engine, DB Listener, and Chain Verifier.

## Component Testing & Mocking
- Run the test environment using: `docker-compose up -d`.
- Kafka topics (`canary-events`, `canary-heartbeats`) are auto-created by an init container (`kafka-init`).
- Certificates for testing zero-disk TLS can be generated using `test-env/generate-certs.ps1`.
- A mock python webhook server is available in `test-env/webhook/` to test alert dispatching.

## Integration & Verification
- `canary_verify` tool validates the state and triggers during deployments.
