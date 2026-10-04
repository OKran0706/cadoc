---
area: ingestion
created: 2026-04-21
priority: high
status: pending
---

# TODO: Implement Backend Ingestion & Liveness Service

Build a stateless backend service to handle Sentinel heartbeats via mTLS and track liveness in Redis.

## Tasks
- [ ] Initialize `src/sentinel/cmd/ingestion/main.go`
- [ ] Configure mTLS server with Project CA verification
- [ ] Implement Ed25519 signature verification (reusing `auth` logic)
- [ ] Implement Redis liveness tracking (`SET EX`)
- [ ] Implement Failure Detection (Redis Expiration listener)
- [ ] Reroute Sentinel-A heartbeats to the new service
