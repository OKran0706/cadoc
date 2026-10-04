---
one_liner: Deployed horizontally scalable ingestion service with NGINX load balancing and mTLS termination.
status: complete
---

# 07-03 Summary: Infrastructure & Horizontal Scaling

## What Was Built
- **Multi-Replica Deployment**: Ingestion service configured with `scale: 2` for horizontal scaling.
- **NGINX Load Balancer**: Round-robin upstream configuration for ingestion service replicas.
- **mTLS Configuration**: NGINx configured for mTLS pass-through to Uvicorn replicas.
- **Docker Network Integration**: All services (redis, kafka, ingestion) on shared network with proper DNS resolution.

## Key Decisions
- **Uvicorn Termination**: mTLS handled at application layer for E2E identity preservation.
- **Round-Robin**: Simple load balancing sufficient for initial deployment; can upgrade to least-conn later.

## Self-Check: PASSED
- [x] `docker-compose up --scale ingestion-service=2` succeeds
- [x] NGINx config routes to upstream replicas
- [x] Fault tolerance verified (stopping one replica doesn't affect liveness)
- [x] Network connectivity confirmed (redis, kafka resolvable)
