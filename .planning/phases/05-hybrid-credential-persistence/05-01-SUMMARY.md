---
one_liner: Implemented hybrid credential persistence with atomic PEM storage and fallback TLS-cert re-authentication path.
status: complete
---

# 05-01 Summary: Hybrid Credential Persistence

## What Was Built
- **Atomic Persistence**: Added `sysutil.PersistPublicCerts` to safely save `ca.crt` and `mtls.crt` using a write-then-rename pattern.
- **Boot Fallback**: Added `sysutil.LoadPersistedCerts` to retrieve certs on restart.
- **Main Flow Update**: Sentinel-A now checks for `--join-token`. If missing, it attempts to load certs from `/var/lib/canary` and uses them to re-authenticate with Vault.
- **Security Hardening**: The private key (`mtls.key`) is strictly prohibited from touching the disk; it is always fetched from Vault into memory.

## Key Decisions
- **Raw PEM**: Used standard PEM format for interoperability and ease of debugging.
- **Vault Cert Auth**: Assumed external configuration of Vault's TLS certificate auth backend.
- **State Separation**: `/var/lib/canary` (managed by systemd) is the canonical home for persistent public material.

## Self-Check: PASSED
- [x] `sysutil.go` contains `PersistPublicCerts`
- [x] `sysutil.go` contains `LoadPersistedCerts`
- [x] `sysutil.go` uses `os.Rename` for atomicity
- [x] `main.go` supports `--state-dir`
- [x] `main.go` falls back to persisted certs when `--join-token` is absent
- [x] Private keys never touch the disk
