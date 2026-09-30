# Canary Detection System

## What This Is

A tamper-resistant, defense-in-depth canary detection system for adversarial environments. It deploys high-fidelity decoy assets (files, PVCs, databases) with a hardened, zero-disk Sentinel daemon that ships signed events remotely, making evasion extremely expensive for attackers.

## Core Value

Asymmetric cost: It must be cheap for an admin to deploy, but extremely expensive and difficult for an attacker to evade silently without detection.

## Requirements

### Validated

- ✓ Standalone Sentinel Daemon (eBPF telemetry gathering) — existing
- ✓ Detection Engine evaluating Kafka event streams — existing
- ✓ Zero-disk capabilities within the `sysutil` internal package — existing

### Active

*(Cleared for next milestone)*

## Current Milestone: v1.1 Sentinel Resilience & Auto-Restart Flow

**Goal:** Implement secure auto-restarts as a system service, transitioning from a pure memory-only model to a hybrid disk-cert / memory-key model, with manual approval required for prolonged downtimes.

**Target features:**
- Register the Sentinel binary as an auto-restarting system service.
- Modify the Vault fetch logic: Persist the mTLS public certificate and CA certificate on disk, but keep the private key strictly in memory.
- Auto-replace credentials on restart: Use the persisted mTLS cert to authenticate and request fresh secrets (new mTLS cert and private key).
- Implement downtime enforcement: If the agent is down for more than `X` minutes, block automatic credential refresh on the backend.
- Implement wait-for-approval polling: While blocked, Sentinel enters an exponential backoff loop, polling Vault for approval without spamming the network.


### Out of Scope

- [ ] Extending canary coverage to active PVC watchdogs and database tables — Deferred to a future milestone to focus purely on the core Sentinel-to-Kafka pipeline stability first.

## Context

Shipped v1.0 Milestone "Core Pipeline & Onboarding" with known gaps (requirements unmet). Restarting planning for the next milestone.

## Constraints

- **Security**: Zero-Disk — Secrets, TLS certs, and Vault tokens must never be written to the host disk.
- **Resilience**: Fail-Closed — If the agent is compromised or disconnected, it must fail aggressively rather than operate in a degraded state.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Prioritize Sentinel A, Kafka, and Detection Engine | Establishes a hardened, production-ready backbone before attempting to expand canary mesh coverage | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-17 after v1.0 milestone*
