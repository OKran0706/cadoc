# External & Internal Integrations

## Messaging & Data
- **Kafka Topics**: 
  - `canary-events`: Agent anomaly and syscall events.
  - `canary-heartbeats`: Health tracking to identify isolated nodes.
- **Databases**: 
  - `canarydb` (Postgres, MySQL) for honeypots and state.

## Security Control Plane
- **HashiCorp Vault**: 
  - Sentinels rely on the Vault API for their entire identity, fetching TLS pairs upon execution.

## Alerting
- **PagerDuty**: Configured via the `CANARY_PAGERDUTY_KEY`.
- **Slack (Webhooks)**: Integration driven by POST requests to `CANARY_SLACK_WEBHOOK`, tested locally via Python flask endpoints.
