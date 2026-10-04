# Research Summary

**Stack additions:**
- Native `systemd` `.service` file for daemon management.
- Python `ssl` library capable of loading certs from memory (`cadata`) or `os.memfd_create()` to ensure private keys never touch disk.
- Robust HTTP retry logic (e.g., `urllib3.util.retry`) for Vault polling.

**Feature table stakes:**
- Exponential backoff polling explicitly inside the Sentinel binary when Vault returns `403 Forbidden` due to downtime thresholds.
- Sentinel writes ONLY `mtls.crt` and `ca.crt` to disk, keeping `mtls.key` in memory.
- `systemd` handles initial crash-restarts but defers to Sentinel's internal polling for manual approval blocks.

**Watch Out For:**
- **Thundering Herd / Spam:** Ensure the Sentinel doesn't hammer Vault. Backoff must be implemented *inside* the agent rather than relying strictly on short `systemd` restart loops.
- **Swap Leaks:** Ensure the memory used to hold the private key doesn't get swapped to disk (`mlock` or purely memory-resident patterns where feasible).
- **Hardened Service:** Utilize systemd's built-in sandboxing features (`ProtectSystem=strict`, `PrivateTmp=yes`) to isolate the Sentinel process further.
