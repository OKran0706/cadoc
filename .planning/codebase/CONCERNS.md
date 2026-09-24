# Concerns & Tech Debt

## Security & Operations Tasks
- **Crash Recovery**: Handling server restarts and process crashes safely in a strictly "zero-disk" environment presents operational complexities. Determining benign crashes versus malicious node isolations requires robust heartbeating and sophisticated Ansible operational playbooks.
- **Vault Dependency**: The entire agent startup sequence is reliant on a highly available HashiCorp Vault cluster. If Vault is down, Sentinels fail to start (fail-closed), which could result in temporary monitoring blindspots.
- **Onboarding Process**: Secure customer onboarding requires a mechanism to securely inject initial secrets into the Sentinel dynamically without leaving a disk footprint.

## Tech Debt
- **Legacy Cleanup**: The transition to the unified `sysutil` package meant removing various file-based and TPM legacy mechanisms. Verification of all edge cases in legacy cleanup is ongoing to ensure no sensitive data falls back to disk.
