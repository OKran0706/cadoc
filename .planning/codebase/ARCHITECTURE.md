# Architecture Map

## High-Level Pipeline
1. **Sentinel Agents (Edge)**: Deployed on target nodes. They utilize eBPF (Tetragon) to monitor system calls and network activity. They operate in a "fail-closed" model with a strictly in-memory (zero-disk) key management strategy using Vault, sending data securely via zero-disk TLS to Kafka.
2. **Message Bus (Kafka)**: Acts as the central nervous system, buffering events and heartbeats.
3. **Detection Engine**: The core analysis component. Sits behind Kafka, correlates events against known signatures and database states, and triggers responses.
4. **Verification & Audit**: The Chain Verifier ensures cryptographic integrity, preventing attackers from spoofing data streams.

## Key Architectonic Principles
- **Zero-disk**: No sensitive cryptographic material or certificates are ever written to disk.
- **Fail-Closed**: If a Sentinel cannot securely communicate or if its integrity is compromised, it isolates itself or reports failure rather than operating in a degraded, insecure state.
