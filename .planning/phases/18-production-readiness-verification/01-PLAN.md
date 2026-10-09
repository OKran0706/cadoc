---
wave: 1
depends_on: []
files_modified:
  - test-env/Vagrantfile
  - test-env/setup-vm.sh
  - scripts/e2e-test.sh
  - scripts/security-audit.sh
autonomous: true
requirements: []
---

# 01. VirtualBox E2E and Security Validation Setup

## Objective
Set up the VirtualBox testing environment, implement the end-to-end (E2E) functional tests, and create the deep security audit script for the Sentinel daemon.

<task>
<read_first>
- .planning/phases/18-production-readiness-verification/18-CONTEXT.md
- .planning/phases/18-production-readiness-verification/18-RESEARCH.md
</read_first>
<action>
1. Create `test-env/Vagrantfile` (or update if exists) to provision an Ubuntu/Debian VM in VirtualBox. Configure a private network so the host can communicate with it.
2. Create `test-env/setup-vm.sh` to install necessary dependencies (like `auditd`) inside the VM and copy the `sentinel-a` binary from the host.
</action>
<acceptance_criteria>
- `test-env/Vagrantfile` contains `config.vm.network "private_network"`
- `test-env/setup-vm.sh` contains commands to install `auditd` and start the sentinel service.
</acceptance_criteria>
</task>

<task>
<read_first>
- test-env/Vagrantfile
- scripts/e2e-test.sh (new)
</read_first>
<action>
Create `scripts/e2e-test.sh` that:
1. Starts a mock ingestion server on the host (e.g., using `nc` or a simple Go script).
2. Triggers an action in the VM that generates an audit event.
3. Asserts that the mock server received the signed event payload correctly.
</action>
<acceptance_criteria>
- `scripts/e2e-test.sh` contains logic to start a mock listener.
- Script triggers an audit event in the VM via SSH/Vagrant.
- Script verifies the event was received and exits 0 on success.
</acceptance_criteria>
</task>

<task>
<read_first>
- src/sentinel/cmd/sentinel-a/main.go
- scripts/security-audit.sh (new)
</read_first>
<action>
Create `scripts/security-audit.sh` that connects to the running VM and performs deep security validation:
1. Checks `/proc/$(pidof sentinel-a)/status` to ensure CapEff matches the expected reduced capabilities (`CAP_NET_ADMIN`, `CAP_SYS_RESOURCE`).
2. Validates `sentinel.service` file for systemd hardening parameters.
3. Checks that no world-writable files exist in `/var/lib/canary`.
</action>
<acceptance_criteria>
- `scripts/security-audit.sh` contains `grep CapEff /proc/` command.
- Script asserts that `sentinel-a` does not run as full root.
- Script exits 0 if all security checks pass.
</acceptance_criteria>
</task>

## Verification
- Run `vagrant up` using the created Vagrantfile.
- Execute `scripts/e2e-test.sh` and ensure it passes.
- Execute `scripts/security-audit.sh` and ensure it passes.

## Must Haves
- The environment must be isolated via VirtualBox.
- E2E tests must validate the full functional flow of Sentinel to the host.
- Security audit must verify strict capability dropping and systemd hardening.
