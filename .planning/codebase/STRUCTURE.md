# Project Structure

## Core Components
- `src/sentinel/`: Primary Go module.
  - `cmd/sentinel-a/`, `cmd/sentinel-b/`: Go entry points for varying agent deployment types.
  - `internal/config/`: Configuration parsing.
  - `internal/sysutil/`: Zero-disk utility wrappers interacting with Vault and managing TLS state purely in-memory.
- `src/detection_engine/`: Rules evaluation and log/event correlation.
- `src/db_canary/`: Honey-tokens and DB simulator code.
- `src/chain_verifier/`: Ensures cryptographic continuity.

## Auxiliary Components
- `src/alert_response/`: Output handlers.
- `src/canary_deployer/`, `src/canary_verify/`: Tooling for deploying canary artifacts logic.
- `src/pvc_watchdog/`: Monitors PVC health in K8s.
- `src/telemetry/`: General aggregation and metric exposure.
- `src/tools/`: Helper scripts (`webhook-receiver`, `generate-ticket`).

## Infrastructure & Configuration
- `ansible/`, `helm/`, `ebpf/`, `scripts/`: Devops, orchestration, and eBPF definitions.
- `test-env/`: Docker Compose and scripts (`generate-certs.ps1`, `webhook/server.py`).
