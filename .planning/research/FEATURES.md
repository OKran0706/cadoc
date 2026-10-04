# Features Research

## Expected Behavior
- **Auto-restart:** `systemctl enable sentinel` ensures daemon starts on boot.
- **Backoff Polling:** If Vault blocks token generation due to `downtime > X minutes`, Sentinel enters a `Wait-For-Approval` log state, polling Vault every N seconds/minutes.
- **Zero-disk Private Keys:** The `mtls.key` pulled from Vault is written directly into `memfd` (Linux memory file) or kept strictly as a Go byte array used for in-memory TLS contexts. Only the new `mtls.crt` and `ca.crt` are written to disk.

## Table Stakes
- systemd unit file with `Restart=always` and `RestartSec=10`.
- Memory-only key loading.
- Exponential backoff loop when Vault returns HTTP 403.

## Differentiators
- Telemetry: Sentinel emitting "Waiting for approval" heartbeats out-of-band if possible.
