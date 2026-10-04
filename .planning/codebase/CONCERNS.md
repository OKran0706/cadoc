# Concerns & Tech Debt

## Security & Operations Risks
- **Crash Differentiation**: In a pure Zero-Disk environment without local states, determining whether a node has maliciously crashed vs normally restarted via Ansible pipelines is highly complex. Relying strictly on heartbeats introduces blind spots.
- **Vault Failure Domain**: Sentinel agents rely deeply on HashiCorp Vault during their `main.go` bootstrap phases. Service degradation of the Vault endpoints causes immediate "fail-closed" events region-wide.
- **Customer Onboarding Friction**: Bootstrapping an agent manually requires strict zero-footprint TLS token passing into memory. Ensuring customers manage this securely requires sophisticated installation wrappers.

## Legacy & Migration Artifacts
- **Legacy Cleanup**: A complete transition to `sysutil` is intended to eradicate prior TPM and file-based keystores. Regression tests must verify that no components mistakenly attempt file fallback architectures.
