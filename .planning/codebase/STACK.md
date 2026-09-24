# Technology Stack

## Core Languages
- **Go**: Primary language for the backend, specifically used for Sentinel agents, Chain Verifier, and DB Listener.
- **Python**: Used for auxiliary tools (Webhook receiver) and test environment scripts.

## Infrastructure & Messaging
- **Kafka & Zookeeper**: Core message bus for transmitting events and heartbeats between Sentinels and backend components.
- **PostgreSQL & MySQL**: Relational databases used by the Canary DB components.
- **Redis**: In-memory data store.

## Security & Observability
- **HashiCorp Vault**: Secret management. Used by Sentinels to fetch keys and TLS certificates directly to memory (zero-disk architecture).
- **eBPF (Tetragon)**: Used by Sentinel agents for deep system observability and security event detection.
- **libcap**: Go wrapper for Linux capabilities.

## Deployment & Environments
- **Docker & Docker Compose**: Used for local setup and integration testing.
- **Ansible & Helm**: Infrastructure as Code (IaC) and Kubernetes deployments.
