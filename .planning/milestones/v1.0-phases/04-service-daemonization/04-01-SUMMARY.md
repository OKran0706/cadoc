---
one_liner: Wrapped Sentinel in a hardened systemd service with CAP_BPF-only privileges and StateDirectory-backed cert persistence.
status: complete
---

# 04-01 Summary: Service Daemonization

## What Was Built
- `deploy/sentinel.service` — A systemd unit file that runs Sentinel as a hardened daemon with:
  - `Restart=always` / `RestartSec=10` for crash recovery
  - `CapabilityBoundingSet=CAP_BPF CAP_PERFMON CAP_SYS_RESOURCE CAP_NET_ADMIN` to drop all unnecessary root capabilities
  - `ProtectSystem=strict` + `StateDirectory=canary` for read-only root FS with auto-provisioned `/var/lib/canary`
  - `PrivateTmp=true`, `ProtectHome=yes`, `NoNewPrivileges=true` for additional hardening

- `scripts/install-sentinel.sh` — Autonomous deployment script that:
  - Copies the binary to `/opt/canary/sentinel`
  - Installs the service unit to `/etc/systemd/system/`
  - Runs `systemctl daemon-reload && systemctl enable --now sentinel.service`

## Key Decisions
- Root with capability bounding chosen over unprivileged user (simpler eBPF setup)
- `StateDirectory=canary` chosen for zero-control VM compatibility (systemd manages the directory lifecycle)

## Self-Check: PASSED
- [x] `deploy/sentinel.service` contains `CapabilityBoundingSet=CAP_BPF`
- [x] `deploy/sentinel.service` contains `ProtectSystem=strict`
- [x] `deploy/sentinel.service` contains `StateDirectory=canary`
- [x] `scripts/install-sentinel.sh` contains `cp deploy/sentinel.service /etc/systemd/system/`
- [x] `scripts/install-sentinel.sh` contains `systemctl daemon-reload`
- [x] `scripts/install-sentinel.sh` contains `systemctl enable --now sentinel.service`
