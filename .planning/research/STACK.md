# Stack Research

## Additions Needed
- **systemd integration:** No new libraries needed, just a `.service` file.
- **In-memory TLS:** Python's `ssl` module can load certificates from strings/memory using `SSLContext.load_verify_locations(cadata=...)` or `memfd` on Linux via `os.memfd_create()`.
- **Vault/Requests:** `requests` retry logic via `urllib3.util.retry.Retry`.

## What NOT to add
- Avoid heavy process supervisors (like Supervisord/PM2) since standard systemd is native and secure.
- Avoid writing the private key to a `tmpfs` RAM disk if you can load it purely via Python variables, as `tmpfs` can be swapped to disk unless swapping is disabled. Keep it strictly in variables or `memfd` with `MFD_CLOEXEC | MFD_ALLOW_SEALING`.
