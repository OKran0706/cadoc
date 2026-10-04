# Canary Detection System

## What This Is

A tamper-resistant, defense-in-depth canary detection system for adversarial environments. It deploys high-fidelity decoy assets (files, PVCs, databases) with a hardened, zero-disk Sentinel daemon that ships signed events to a centralized, non-blocking ingestion service.

## Core Value

Asymmetric cost: It must be cheap for an admin to deploy, but extremely expensive and difficult for an attacker to evade silently without detection.

## Current State

- **Milestone v1.2 Shipped (2026-04-21)**: Unified telemetry pipeline with horizontal ingestion scaling and mTLS verification.
- **Milestone v1.1 Shipped (2026-04-21)**: Sentinel-A daemonized with hybrid credential persistence and resilient Vault polling.
- **Milestone v1.0 Shipped (2026-04-17)**: Core pipeline and Vault integration established.

## Next Milestone Goals (v1.3)

- **Standalone Monitoring**: Remove external eBPF dependencies by embedding native probes directly into the Sentinel binary.
- **Active File Monitoring (FIM)**: Implement the polling fallback to ensure 100% visibility even on older kernels.
- **Zero-Dependency Agent**: Enable seamless systemd-based installation without requiring Tetragon or Kubernetes.
- **Fail-Safe Verification**: Perform Failure Injection (Phase 11) to validate resilience under backend outages.

## Context

<details>
<summary><b>v1.2 Integrated Test Environment (Shipped 2026-04-21)</b></summary>

Established a stable, unified test environment for the Canary Detection System. Delivered the horizontal scaling infrastructure for the ingestion service, migrated Sentinel-A to mTLS ingestion, and verified end-to-end telemetry flow through Redis liveness tracking.
</details>

<details>
<summary><b>v1.1 Sentinel Resilience & Auto-Restart Flow (Shipped 2026-04-21)</b></summary>

Successfully implemented secure auto-restarts as a system service, transitioned to a hybrid disk-cert / memory-key model, and unified all heartbeat and event telemetry through a horizontally scalable, non-blocking FastAPI proxy.
</details>

<details>
<summary><b>v1.0 Core Pipeline & Onboarding (Shipped 2026-04-17)</b></summary>

Established the base Sentinel-A agent, Vault integration, and Kafka event bus.
</details>

## Constraints

- **Security**: Zero-Disk — Secrets, sensitive keys, and Vault tokens must never be written to the host disk.
- **Resilient Delivery**: Non-Blocking — Telemetry delivery must not impact agent performance or disk health (log-and-drop policy).

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Pivot to Unified Ingestion | Decouples agents from Kafka complexity and simplifies mTLS trust management | ✅ v1.1 |
| Log-and-Drop Policy | Prioritizes system stability and memory safety over event persistence | ✅ v1.1 |
| Autonomous BPF Monitoring | Transitioning to native ebpf-go to remove external daemon requirements | 🚧 v1.3 |

---
*Last updated: 2026-04-21 after v1.2 milestone*
