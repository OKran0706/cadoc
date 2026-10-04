# Technology Stack

## Core Languages
- **Go**: Primary language for the backend (Sentinel agents, Chain Verifier, DB Listener). Core internal packages manage sysutils and configuration.
- **Python**: Used for auxiliary tools, primarily the webhook receiver.

## Infrastructure & Messaging
- **Kafka & Zookeeper**: Core message bus for transmitting events and heartbeats between Sentinels and backend components.
- **PostgreSQL & MySQL**: Relational databases for local Canary DB instances.
- **Redis**: In-memory data store for caching and intermediate state.

## Security & Observability
- **HashiCorp Vault**: Secret management. Sentinels fetch keys and TLS certs into memory (Zero-Disk architecture).
- **eBPF (Tetragon)**: High-performance syscall and network activity monitoring on agent nodes.
- **libcap**: Go wrapper for Linux capabilities to manage service privileges.

## Deployment & Environments
- **Docker & Docker Compose**: Orchestrates local environments spanning Kafka, Postgres, and the Canary Engine.
- **Ansible & Helm**: IaaC pipelines.
