# Phase 25 Plan: Vault-less Sentinel Architecture

This plan removes the Vault SDK dependency from the Sentinel by proxying all secret operations (Signer Keys, Maintenance Keys, and Killswitches) through the Ingestion Service.

## Proposed Changes

### 1. Ingestion Service (Python)

#### [MODIFY] [bootstrap.py](file:///c:/Users/Karan/Desktop/canary/cadoc/src/ingestion_service/bootstrap.py)
- Import `cryptography.hazmat.primitives.asymmetric.ed25519`.
- Add `generate_signer_key()` helper.
- Update `fetch_sentinel_credentials` and `fetch_sentinel_credentials_by_client_id`:
  - Generate a new Ed25519 keypair during bootstrap.
  - Store the private key in Vault at `secret/data/canary/sentinels/{client_id}/signer`.
  - Include the hex-encoded private key in the returned dictionary as `signer_key`.

#### [MODIFY] [main.py](file:///c:/Users/Karan/Desktop/canary/cadoc/src/ingestion_service/main.py)
- Add `GET /bootstrap/maintenance_key`: Reads `secret/data/canary/maintenance` from Vault and returns the public key.
- Add `GET /control/killswitch`: Reads `secret/data/canary/control` from Vault and returns the signed ticket.
- These endpoints require mTLS authentication (provided by the Sentinel's identity cert).

### 2. Sentinel (Go)

#### [MODIFY] [signer.go](file:///c:/Users/Karan/Desktop/canary/cadoc/src/sentinel/internal/signer/signer.go)
- Remove `internal/vault` import.
- Update `New()` to take a raw hex string or byte slice for the private key instead of a `vault.Client`.
- Remove the `KeySource` logic that contacts Vault.

#### [MODIFY] [provisioning.go](file:///c:/Users/Karan/Desktop/canary/cadoc/src/sentinel/internal/auth/provisioning.go)
- Update `BootstrapFromIngestionService` and `RecoverFromIngestionService` to return `signerKey` along with certs and tokens.
- Add `GetMaintenanceKey(ctx, ic)` and `GetKillSwitch(ctx, ic)` helpers.

#### [MODIFY] [main.go](file:///c:/Users/Karan/Desktop/canary/cadoc/src/sentinel/cmd/sentinel-a/main.go)
- Remove all `vault` package imports and usages.
- Update bootstrap/recovery logic to initialize the `signer.Signer` using the bundled `signerKey`.
- Update the Killswitch Poller and Maintenance initialization to use the new `auth` brokered helpers.
- Remove `refreshVaultAccess` (obsolete).

#### [DELETE] [vault](file:///c:/Users/Karan/Desktop/canary/cadoc/src/sentinel/internal/vault)
- Delete the entire package.

### 3. Build & Dependencies

#### [MODIFY] [go.mod](file:///c:/Users/Karan/Desktop/canary/cadoc/go.mod)
- Run `go mod tidy` to remove `github.com/hashicorp/vault/api`.

## Verification Plan

### Automated Tests
- Run `setup-verify.sh` in Vagrant.
- Verify that `sentinel-a` starts correctly without any Vault environment variables (except those used by the Ingestion Service).
- Verify that the binary size of `sentinel-a` is reduced (due to Vault SDK removal).
- Trigger a Killswitch update in Vault and verify that the Ingestion Service proxies it and the Sentinel reacts.

### Manual Verification
- `ldd sentinel-a` (or equivalent) to ensure no unexpected dynamic links, though Vault is static.
- Inspect Sentinel logs for "Vault" keywords to ensure no legacy calls are remaining.
