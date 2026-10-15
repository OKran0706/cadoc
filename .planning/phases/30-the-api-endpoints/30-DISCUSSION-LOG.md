# Phase 30: the api endpoints - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-21
**Phase:** 30-the-api-endpoints
**Areas discussed:** Route Names & Alignment, Mitigation Lifecycle, Uptime and Heartbeat Fallbacks, Virtual 2D Grid for Heatmap

---

## Route Names & Alignment

| Option | Description | Selected |
|--------|-------------|----------|
| Option A | **Unified `/api/v1/dashboard/` Namespace.** Group all dashboard specific operations under a clean common prefix. | ✓ |
| Option B | **Top-Level Routing.** Expose them directly under `/api/v1` (e.g. `/api/v1/nodes`). | |
| Option C | **Hybrid Routing.** Nodes under `/api/v1/nodes`, KPIs under `/api/v1/dashboard/`. | |

**User's choice:** Option A (Unified namespace under `/api/v1/dashboard/...`)
**Notes:** Grouping all endpoints under a single namespace maintains clear routing separation.

---

## Mitigation Lifecycle

| Option | Description | Selected |
|--------|-------------|----------|
| Option A | **Immutable & Append-Only.** Track mitigations in `alert_mitigations` join table; no deletion support to maintain permanent forensic audit logs. | ✓ |
| Option B | **Mutable Mitigations.** Support deleting mitigation rows so alerts revert to active status. | |

**User's choice:** Option A (Immutable & Append-Only)
**Notes:** Alignment with immutable forensics guidelines for tamper-resistant logs.

---

## Uptime and Heartbeat Fallbacks

| Option | Description | Selected |
|--------|-------------|----------|
| Option A | **Resilient Fallbacks.** Fallback to 100% uptime on 0 agents, null telemetry metrics when heartbeats expire while keeping static metadata. | ✓ |
| Option B | **Strict State.** Fallback to 0.0% uptime on 0 agents, keep last telemetry metrics cached indefinitely without Redis TTL. | |

**User's choice:** Option A, but with custom zero-agent handling: return `"N/A"` for network uptime when registered agents count is 0.
**Notes:** Specifically override zero-agent uptime fallback to show `"N/A"` instead of a numeric 100% or 0% value to make it obvious that no agents are registered.

---

## Virtual 2D Grid for Heatmap

| Option | Description | Selected |
|--------|-------------|----------|
| Option A | **Stable Geographic/Project Grouping.** Square grid sized dynamically; sequental node mapping grouped by project/location. | ✓ |
| Option B | **Deterministic Hash Map.** Fixed 10x10 grid; deterministic hash coordinates. | |

**User's choice:** Option A (Stable geographic/project grouping and dynamic grid sizing).
**Notes:** Best visual clustering performance for dashboards.

---

## the agent's Discretion

- Choice of standard FastAPI logging, CSV layout format, and precise grid coordinate formulas is at the agent's discretion.

---

*Phase: 30-the-api-endpoints*
*Discussion log generated: 2026-05-21*
