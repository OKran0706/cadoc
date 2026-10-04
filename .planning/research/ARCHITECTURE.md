# Architecture Research

## Integration Points
- **Systemd Service Unit:** A `.service` file to manage the Sentinel binary lifecycle.
- **Vault Token/Cert Backend:** Sentinel needs a loop to fetch secrets, replacing old ones in memory and persisting public mTLS on disk.
- **Downtime Threshold Logic:** Needs to be enforced by the backend (e.g. Vault token TTL, Kafka ACL revocation) or locally via a signed timestamp mechanism.

## Data Flow Changes
1. **Boot/Restart:** Systemd starts Sentinel.
2. **Pre-flight:** Sentinel checks disk for `ca.crt` and `mtls.crt`.
3. **Fetch Secrets:** Sentinel authenticates via mTLS to Vault -> Vault checks block status -> returns `mtls.key`, `mtls.crt`, and operational secrets.
4. **Operation:** Sentinel runs purely from memory.

## Suggested Build Order
1. Implement Vault downtime threshold blocking.
2. Modify Sentinel authentication to support mTLS cert polling with backoff.
3. Systemd service integration.
