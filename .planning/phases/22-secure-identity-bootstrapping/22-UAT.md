# Phase 22 UAT: Secure Identity Bootstrapping

**Goal:** Verify brokered identity acquisition for Sentinel via Ingestion Service with mTLS.

## Test Cases

| ID | Test Case | Expected Result | Status |
|---|---|---|---|
| TC-01 | **Fresh Bootstrap** | Sentinel uses Join Token, fetches certs, persists public material, and keeps private key in-memory. | ✅ PASSED |
| TC-02 | **Restart Recovery** | Sentinel restarts without token, uses persisted public certs to re-authenticate with Ingestion Service (`/bootstrap/renew_credentials`) and fetches fresh credentials. | ✅ PASSED |
| TC-03 | **Token One-Time Use** | Reusing a Join Token (JWT) results in a `403 Forbidden` from the Ingestion Service. | ✅ VERIFIED |
| TC-04 | **Fail-Closed (Revocation)** | If certs are revoked/invalid on restart, Sentinel fails closed with fatal error. | ⏳ PENDING |

## Execution Log

### 2026-05-16 — Environment Setup

- [x] Build Sentinel binary for Linux (AMD64)
- [x] Identify Vagrant VM and ensure connectivity
- [x] Initialize mock Vault with Sentinel secrets
- [x] Start Ingestion Service on Host (inside VM for isolation)
- [x] Generate User JWT for admin access

### Test Results

- **TC-01:** Sentinel successfully exchanged JWT Join Token for certs. Log confirmed: `Persisted public certs to /var/lib/canary (private key remains in memory only)`.
- **TC-02:** Sentinel correctly detected missing token on restart, used its persisted mTLS cert to hit Ingestion Service `/bootstrap/renew_credentials`, and successfully re-acquired its private key into memory.
- **TC-03:** Ingestion service log showed Redis JTI check working.
