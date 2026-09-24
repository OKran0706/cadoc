# External & Internal Integrations

## Messaging & Data
- **Kafka Topics**: 
  - `canary-events`: High-volume system events detected by Sentinels.
  - `canary-heartbeats`: Periodic check-ins and health status of agents.
- **Databases**: 
  - `canarydb` (PostgreSQL on 5432, MySQL on 3306)

## Security
- **HashiCorp Vault**: 
  - Central source for TLS certificates and cryptographic keys. Sentinel interacts with Vault API directly to adhere strictly to the zero-disk design.

## Alerting & Notifications
- **PagerDuty**: Configured via `CANARY_PAGERDUTY_KEY` in the Detection Engine for high-priority incidents.
- **Slack**: Integrated via Webhook (`CANARY_SLACK_WEBHOOK`) for team alerts and general monitoring.
