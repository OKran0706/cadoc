# Phase 12: Functional Container Verification

This phase validates the Native Auditd integration by deploying Sentinel-A into a privileged Docker container.

## Objectives
- [ ] Build and cross-compile Sentinel-A for Linux.
- [ ] Create a privileged Docker environment with `auditd` support.
- [ ] Verify that Sentinel-A correctly registers as an `audispd` plugin inside the container.
- [ ] Trigger a canary file tampering event and confirm the signed alert is generated.

## Proposed Changes

### [NEW] test-env/Dockerfile.audit
Specialized Ubuntu-based image containing `auditd` and the Sentinel consumer.

### [NEW] test-env/run-audit-test.sh
Driver script to handle the build, container lifecycle, and event injection.

## Verification
- **Log Audit**: Confirm `[auditmon] IPC server listening` and `[auditmon] ALERT: Detected file removal`.
- **Signer Audit**: Verify the resulting event is signed with the Ed25519 key.
