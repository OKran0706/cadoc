# Project Structure

## Core Components
- `src/sentinel/`: Go module containing the Sentinel agent.
  - `cmd/sentinel-a/`, `cmd/sentinel-b/`: Entry points for specific Sentinel deployments.
  - `internal/`: Implementation details (eBPF probes, Vault integration, Kafka producers).
- `src/detection_engine/`: Rules evaluation and processing logic.
- `src/db_canary/`: Honey-tokens and DB activity listener/simulator logic.
- `src/chain_verifier/`: Ensures cryptographic integrity of event streams.

## Auxiliary Components
- `src/alert_response/`: Output handlers for PagerDuty, Slack, etc.
- `src/canary_deployer/`, `src/canary_verify/`: Tooling for deploying and verifying canary resources.
- `src/pvc_watchdog/`: Monitors Kubernetes Persistent Volume Claims.
- `src/telemetry/`: General telemetry aggregation.
- `src/tools/`: Utilities like `generate-ticket` and `webhook-receiver`.

## Infrastructure & Configuration
- `ansible/`, `helm/`, `ebpf/`, `scripts/`: Deployment manifests, configuration scripts, and eBPF probes.
- `test-env/`: Docker Compose, TLS certificate generation scripts (`generate-certs.ps1`), and testing webhooks.
