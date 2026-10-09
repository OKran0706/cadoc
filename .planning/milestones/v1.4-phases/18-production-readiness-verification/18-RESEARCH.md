# Phase 18: Production Readiness Verification - Research

## Objective
Research how to implement Phase 18: Production Readiness Verification. Focus on setting up a VirtualBox environment, running E2E functional tests, and performing deep security validation on the Sentinel daemon.

## Environment Strategy
- **VirtualBox Setup**: We need to provision a VirtualBox VM running a target Linux distribution (e.g., Ubuntu/Debian) where `sentinel-a` will be deployed.
- **Networking**: Host-only or NAT network with port forwarding will be required so the host can send/receive telemetry to/from Sentinel, simulating the external supporting services.
- **Provisioning**: Vagrant or a simple bash script using `VBoxManage` can automate the VM creation, dependency installation, and Sentinel binary transfer.

## Load/Performance Testing (E2E Functional)
- **E2E Approach**: Focus on functional end-to-end testing. We need a test script that:
  1. Bootstraps the VM with Sentinel.
  2. Injects simulated audit events.
  3. Verifies that the events are signed, processed, and transmitted back to the host correctly.
- **Tools**: Go's native `testing` package with build tags (e.g., `//go:build e2e`) or a bash test harness. A mock ingestion server running on the host can validate the received events.

## Security Validation
- **Deep Security Audit**: 
  1. **Capabilities Check**: Verify that Sentinel correctly drops capabilities and runs with only `CAP_NET_ADMIN` and `CAP_SYS_RESOURCE`. Check `/proc/<pid>/status` for CapEff.
  2. **Systemd Hardening Check**: Validate the `sentinel.service` file for `ProtectSystem`, `ProtectHome`, `PrivateTmp`, etc.
  3. **Privilege Escalation Paths**: Ensure no world-writable files are created in the state directory and the PID file is secured.
  4. **Network Scanning**: Verify Sentinel only listens on intended ports and drops unauthorized connections.

## Technical Risks
- VM provisioning automation failing due to varying host OS environments.
- Network routing issues between VirtualBox and the host preventing the mock ingestion server from receiving events.
- Auditd rules on the VM interfering with default host OS rules if not properly isolated.
