# Testing Strategy

## Orchestration Pipeline (Local)
- Standard testing runs under `docker-compose.yml` natively spinning up a dense simulation environment including Kafka, Postgres, MySQL, Redis, Sentinel proxies, Detection Engines, and Chain Verifiers.
- **Init Containers**: Services like `kafka-init` automatically configure pre-requisite topic topologies.

## External Service Mocking
- Alerting endpoints are mocked using the python scripts located in `test-env/webhook/`.
- Vault and TLS integration verification relies on locally-generated `test-env/generate-certs.ps1` chains ensuring zero-disk testing integrity without depending on cloud components.

## Verification Boundaries
- **canary_verify**: Utilized to script post-deployment functional UAT paths and enforce data expectations.
