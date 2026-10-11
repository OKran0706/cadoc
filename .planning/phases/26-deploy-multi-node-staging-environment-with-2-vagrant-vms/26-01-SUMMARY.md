---
plan: "26-01"
phase: 26
subsystem: "test-env"
tags: ["vagrant", "staging", "multinode", "docker-compose", "auditd", "systemd", "mtls"]
duration: "25min"
completed: "2026-05-17T11:19:00Z"
---

# Plan 26-01 Summary: Multi-Node Vagrant Staging Environment

## What Was Built

Transformed the Canary Detection System test environment from a single-VM Vagrant layout into a fully isolated 2-node staging environment. The two VMs communicate over a private VirtualBox host-only network (`192.168.56.0/24`), reproducing real-world network separation between the Sentinel agent and the centralized telemetry control plane.

Key deliverables:
- **Vagrantfile** refactored into a named 2-machine definition (`server` + `sentinel`)
- **`setup-server.sh`** provisions VM 1 with Docker, launches the full compose stack
- **`docker-compose-multinode.yml`** adapts the existing stack: adds `192.168.56.11` to TLS SANs, removes containerized sentinel (now runs natively on VM 2)
- **`setup-sentinel.sh`** provisions VM 2 natively: installs auditd, registers audispd plugin, writes `sentinel.yaml` targeting VM 1's mTLS LB, creates hardened systemd service
- **`verify-multinode.sh`** orchestrates the full E2E bootstrap sequence from the host

## Key Files Created/Modified

| File | Action | Description |
|------|--------|-------------|
| `test-env/Vagrantfile` | Modified | 2-node definition: `server` (192.168.56.11, 2GB) + `sentinel` (192.168.56.12, 1GB) |
| `test-env/setup-server.sh` | Created | Docker install + `docker-compose-multinode.yml` launch on VM 1 |
| `test-env/docker-compose-multinode.yml` | Created | Full stack minus sentinel-a; server TLS SANs include `IP:192.168.56.11` |
| `test-env/setup-sentinel.sh` | Created | auditd + audispd plugin + hardened systemd service on VM 2 |
| `test-env/verify-multinode.sh` | Created | 9-step E2E orchestration: ping → health → join token → bootstrap → creds → start → audit → verify |

## Commits

| Task | Hash | Description |
|------|------|-------------|
| T1 | `66051f3` | feat(phase-26): refactor Vagrantfile for 2-node VM topology |
| T2 | `8e0857d` | feat(phase-26): add server provisioning script setup-server.sh |
| T3 | `c506c6e` | feat(phase-26): add multinode docker-compose with 192.168.56.11 SANs, remove sentinel-a container |
| T4 | `899b7c3` | feat(phase-26): add sentinel VM provisioning script setup-sentinel.sh |
| T5 | `9196dc5` | feat(phase-26): add multi-node E2E verification script verify-multinode.sh |

## Notable Decisions

1. **sentinel-a NOT started on boot**: The systemd service is registered but not enabled on VM 2. The sentinel daemon awaits a brokered Join Token from the Phase 22/25 bootstrap flow, so autostart would fail before credentials are provisioned.

2. **IP:192.168.56.11 in TLS SANs**: The `cert-generator` service in the new compose file includes the VM 1 private IP in the server certificate's Subject Alternative Names. Without this, the Go TLS client on VM 2 would reject the NGINX connection with a handshake error.

3. **Shared folder as token broker**: Rather than requiring SSH key setup for cross-VM communication, the Join Token is written to the Vagrant-synced `certs/` directory which maps to `/vagrant/certs/` on both VMs — a simple, zero-setup token broker.

4. **Audispd plugin directory detection**: `setup-sentinel.sh` checks for both `/etc/audit/plugins.d` (Ubuntu 22.04) and `/etc/audisp/plugins.d` (older distros), creating the directory if needed — matching the existing `setup-vm.sh` pattern.

5. **verify-multinode.sh `--quick` mode**: The script supports a quick mode that only checks network connectivity, suitable for the Nyquist validation task ID `26-01-01` which just verifies VM registration without full services.

## Self-Check

| Check | Status |
|-------|--------|
| Vagrantfile defines `server` (192.168.56.11) and `sentinel` (192.168.56.12) | ✅ |
| `setup-server.sh` installs `docker.io` and runs `docker-compose-multinode.yml` | ✅ |
| `docker-compose-multinode.yml` has `IP:192.168.56.11` in cert SAN | ✅ |
| `docker-compose-multinode.yml` has no `sentinel-a:` service | ✅ |
| `setup-sentinel.sh` writes `sentinel.yaml` with `https://192.168.56.11:8443/ingest` | ✅ |
| `setup-sentinel.sh` registers audispd plugin and creates systemd service | ✅ |
| `verify-multinode.sh` has 9 E2E steps incl. `--quick` and `--full` modes | ✅ |
| All 5 tasks committed atomically | ✅ |

## Self-Check: PASSED
