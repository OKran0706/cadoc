# Canary Detection System

## What This Is

A tamper-resistant, defense-in-depth canary detection system for adversarial environments. It deploys high-fidelity decoy assets (files, PVCs, databases) with a hardened, zero-disk Sentinel daemon that ships signed events to a centralized, non-blocking ingestion service.

## Core Value

Asymmetric cost: It must be cheap for an admin to deploy, but extremely expensive and difficult for an attacker to evade silently without detection.

## Requirements

### Validated

- ✓ Standalone Sentinel Daemon (eBPF telemetry gathering) — existing
- ✓ Detection Engine evaluating Kafka event streams — existing
- ✓ Zero-disk capabilities within the `sysutil` internal package — existing
- ✓ **Service Daemonization**: auto-restarting systemd integration (v1.1)
- ✓ **Hybrid Credential Persistence**: atomic cert persistence for restart recovery (v1.1)
- ✓ **Resilient Vault Polling**: exponential backoff for downtime handling (v1.1)
- ✓ **Unified Ingestion**: non-blocking FastAPI proxy with mTLS and signature verification (v1.1)

### Active

*(Cleared for next milestone - run /gsd-new-milestone)*

## Current Milestone: (Planning Next)

**Goal:** Expand canary mesh coverage and finalize the fleet management monitoring layer.

## Context

<details>
<summary><b>v1.1 Sentinel Resilience & Auto-Restart Flow (Shipped 2026-04-21)</b></summary>

Successfully implemented secure auto-restarts as a system service, transitioned to a hybrid disk-cert / memory-key model, and unified all heartbeat and event telemetry through a horizontally scalable, non-blocking FastAPI proxy fronted by Nginx. All Sentinel agents are now decoupled from direct Kafka connections.
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
| Pivot to Unified Ingestion | Decouples agents from Kafka complexity and simplifies mTLS trust management at the load balancer level | ✅ v1.1 |
| Log-and-Drop Policy | Prioritizes system stability and memory safety over event persistence during upstream outages | ✅ v1.1 |

---
*Last updated: 2026-04-21 after v1.1 milestone*
