# Phase 4: Service Daemonization - Context

**Gathered:** 2026-04-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Wrapping the Sentinel binary (Go) in a robust systemd service that enforces file sandboxing and manages the process lifecycle, specifically tailored for a "zero control" client VM environment where autonomous recovery is critical.
</domain>

<decisions>
## Implementation Decisions

### Service Privileges
- **D-01:** Run Sentinel as root but explicitly lock down the `CapabilityBoundingSet` to strip away full root capabilities like `CAP_SYS_ADMIN`. Retain only `CAP_BPF` and the necessary networking capabilities for telemetry and Kafka egress.

### Sandboxing Depth
- **D-02:** Utilize systemd's `ProtectSystem=strict` to enforce a read-only filesystem for the daemon.
- **D-03:** Use the systemd `StateDirectory=canary` feature to fully autonomously provision `/var/lib/canary`. This acts as the explicitly allowed read-write location for the persisted mTLS public cert and CA root cert, bypassing the need for manual installation/permission scripts since we have zero control over the VM state post-deployment.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Systemd Integration
- `.planning/research/ARCHITECTURE.md` — Defines integration points and the expected data flow.
- `.planning/research/PITFALLS.md` — Details common mistakes with systemd sandbox testing and Vault polling blocks.
</canonical_refs>
