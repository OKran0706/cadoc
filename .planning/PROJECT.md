# Canary Detection System

## What This Is

A tamper-resistant, defense-in-depth canary detection system for adversarial environments. It leverages native Linux auditing (`auditd`) to monitor high-fidelity decoy assets with a zero-disk, hardened Sentinel daemon that ships signed events to a centralized, non-blocking ingestion service.

## Core Value

Asymmetric cost: It must be cheap for an admin to deploy, but extremely expensive and difficult for an attacker to evade silently without detection.

## Current State

- **Milestone v1.4 Active**: Sentinel-A hardening, graceful shutdown, and structured error handling.
- **Milestone v1.3 Shipped (2026-04-22)**: Zero-dependency Auditd-only architecture with live rule injection and resilient IPC.
- **Milestone v1.2 Shipped (2026-04-21)**: Unified telemetry pipeline with horizontal ingestion scaling and mTLS verification.
- **Milestone v1.1 Shipped (2026-04-21)**: Sentinel-A daemonized with hybrid credential persistence and resilient Vault polling.
- **Milestone v1.0 Shipped (2026-04-17)**: Core pipeline and Vault integration established.

## Requirements

### Validated

- ✓ Native Auditd record reassembly (`libaudit`) — v1.3
- ✓ Live Auditctl rule injection (Zero-Disk) — v1.3
- ✓ Resilient IPC with exponential backoff — v1.3
- ✓ Subsystem liveness monitoring — v1.3

### Active

- [ ] **v1.4: Sentinel Hardening & Refactoring**
  - [ ] Graceful shutdown and goroutine lifecycle management
  - [ ] Structured Vault error handling and strict error checking
  - [ ] Shared HTTP client with context support
  - [ ] Capability drop order and privileged op audit
- [ ] Automated Canary Placement (Policy Engine)
- [ ] Multi-Tenant Ingestion Isolation
- [ ] Hardware-backed Key Storage (TPM 2.0 Integration)

### Out of Scope

- Real-time eBPF Tracing — Deprecated in favor of Auditd for stability and privilege reduction.
- Kernel-space Enforcement — System focuses on high-fidelity detection, not blocking.

## Context

Shipped v1.3 with a pure Auditd model, eliminating the need for eBPF or Tetragon. Sentinel-A now operates with minimal capabilities (`CAP_NET_ADMIN`, `CAP_SYS_RESOURCE`) and manages rules in live memory only.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Pivot to Auditd-Only | Removes high-privilege eBPF requirements and improves compatibility across kernels | ✅ v1.3 |
| Live Rule Injection | Maintains zero-disk constraint for security | ✅ v1.3 |
| Unified Ingestion | Decouples agents from Kafka complexity and simplifies mTLS trust management | ✅ v1.1 |

---
*Last updated: 2026-04-22 after v1.3 milestone*
