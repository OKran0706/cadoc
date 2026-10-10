# PLAN: Phase 25 — Vault-less Sentinel Architecture

## Goal
Remove direct communication between Sentinel and Vault. Use Ingestion Service as the sole secret broker.

## Proposed Changes

### 1. Ingestion Service (Python)
- **Endpoint**: `GET /bootstrap/config`
- **Logic**: 
  - Identify Sentinel via mTLS Client Cert.
  - Fetch `signing_key` and `auth_pubkey` from Vault KV.
  - Return JSON.

### 2. Sentinel (Go)
- **New Package**: `internal/broker` (HTTP client for Ingestion Service).
- **Cleanup**: Delete `internal/vault`.
- **Refactor**: 
  - `signer.New` takes `broker.Client`.
  - `auth.IsProvisioned` and recovery logic updated.
  - `main.go` wires everything to the broker.

## Verification
- Vagrant VM: Fresh boot -> Restart -> Verify no Vault connections from Sentinel.
