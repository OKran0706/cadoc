# Pitfalls Research

## Common Mistakes
- **Spamming Vault API:** `Restart=Always` in systemd with no backoff inside the binary can result in hammering Vault or Kafka if the wait loop is misconfigured. Prevention: Internal exponential backoff inside the binary, instead of relying solely on systemd restarts.
- **Accidental Key Leaks:** Using standard file I/O libraries that silently cache to disk or `/tmp`. Prevention: Strict usage of `memfd_create` or memory-only byte streams for `tls.Config`.
- **Systemd Mounts:** Not securing the disk path where public certs are stored. Prevention: Restrict permissions in the systemd unit (e.g., `ProtectHome=yes`, `ProtectSystem=strict`).

## Which phase should address it
- The backoff logic and memory-key mechanism should be addressed in the first phase.
- Systemd hardening and final integration testing in the second.
