# Requirements: v1.6 Trusted Identity & Orchestration

This milestone establishes a "Trusted Orchestrator" pattern where the Ingestion Service acts as a broker for Sentinel identities and Vault access, eliminating the need for pre-placed long-lived credentials.

## 1. Identity & Handshake (AUTH)

- [ ] **AUTH-01**: Implement a brokered handshake where a Sentinel uses a one-time "Join Token" to request its permanent identity from the Ingestion API.
- [ ] **AUTH-02**: The Ingestion Service shall use Vault's AppRole engine to generate a `SecretID` for the Sentinel upon successful validation of the Join Token.
- [ ] **AUTH-03**: Sentinels shall implement logic to perform the initial AppRole login using the brokered `SecretID` to obtain their management token.
- [ ] **AUTH-04**: Implement secure delivery of the initial handshake via Vault Response Wrapping (`X-Vault-Wrap-TTL`) to ensure the API never sees plaintext credentials.

## 2. Dynamic PKI (PKI)

- [ ] **PKI-01**: Integrate with Vault's PKI engine to issue short-lived mTLS certificates for Sentinels dynamically after identity bootstrapping.
- [ ] **PKI-02**: Implement automatic background renewal of mTLS certificates with jittered retry logic.

## 3. Operations & Safety (OPS)

- [ ] **OPS-01**: Implement log redaction middleware to ensure Vault tokens and sensitive headers are never recorded in system logs.
- [ ] **OPS-02**: Add a `sentinel-a bootstrap` command or flag to handle the one-time enrollment process gracefully.

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| AUTH-01 | 22 | Pending |
| AUTH-02 | 22 | Pending |
| AUTH-03 | 22 | Pending |
| AUTH-04 | 22 | Pending |
| PKI-01 | 23 | Pending |
| PKI-02 | 23 | Pending |
| OPS-01 | 22 | Pending |
| OPS-02 | 22 | Pending |
