# Phase 4: Discussion Log

**Q1: How should we handle eBPF capability bounding?**
- A: Full root (Default)
- B: Drop all except eBPF caps (Recommended)
- C: Unprivileged User + AmbientCaps
*User Selection*: B

**Q2: Where should the Sentinel persist its public Vault certificates?**
- A: `/var/lib/canary`
- B: `/etc/canary/certs`
- C: `/tmp/canary`
*User Selection*: Noted they will have "zero control on the client vm".
*Clarification*: Agreed to use systemd `StateDirectory=canary` to automatically provision `/var/lib/canary` locally without any custom scripting.
