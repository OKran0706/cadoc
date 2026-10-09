# Plan: 07-03 — Infrastructure & Horizontal Scaling

Deploy the unified ingestion service in a horizontally scalable configuration with mTLS termination and load balancing.

## Proposed Changes

### Infrastructure
#### [MODIFY] [docker-compose.yml](file:///c:/Users/Karan/Desktop/canary/cadoc/docker-compose.yml)
- **Ingestion Service**: Use multiple replicas (e.g., `scale: 2`).
- **Load Balancer**: Add an `nginx` service to act as a round-robin load balancer.
- **mTLS**: Configure Nginx to handle mTLS-termination (if preferred) or pass-through to Uvicorn replicas. *Decision: Pass-through for E2E mTLS, or Nginx termination for performance.* (Let's stick to Uvicorn termination per D-15 for now, but optimize composition).

#### [NEW] [deploy/nginx/ingestion-lb.conf](file:///c:/Users/Karan/Desktop/canary/cadoc/deploy/nginx/ingestion-lb.conf)
- Simple round-robin upstream configuration for the `ingestion-service`.

## Verification Plan
- **Scaling Test**: Run `docker-compose up --scale ingestion-service=3`.
- **Fault Tolerance**: Stop one replica while Sentinel-A is emitting heartbeats; verify no loss of liveness in Redis.
- **Network Check**: Verify that the Ingestion Service can resolve and connect to both `redis` and `kafka` on the shared Docker network.
