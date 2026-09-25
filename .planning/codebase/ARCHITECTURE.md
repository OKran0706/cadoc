# Architecture Map

## High-Level Pipeline
1. **Sentinel Agents (Edge)**: Deployed on target nodes with elevated capabilities (`libcap`) to capture eBPF traffic. Must never persist cryptographic secrets to disk via `sysutil`. They connect via Zero-Disk TLS to Kafka headers.
2. **Message Bus (Kafka)**: Central ingestion for agent heartbeats and events, running redundantly.
3. **Detection Engine**: Correlates streams against defined rules and database states, taking automated actions if anomalies manifest.
4. **Chain Verifier**: Secures streams structurally—auditors verifying event chains haven't been retroactively disrupted.

## Key Principles
- **Zero-disk operations**: All Sentinel interactions must resolve tokens exclusively in RAM.
- **Fail-Closed**: A compromised or network-isolated agent will kill connections/shutdown rather than execute without verification, ensuring total silence represents a breach.
