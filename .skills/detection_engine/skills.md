---
name: detection_engine
description: Guidelines and instructions for working with the detection_engine component
---

# Detection Engine Component

## Overview
The `detection_engine` component evaluates conditions, applies rules against incoming data streams (e.g., from Kafka), and triggers alerts based on evaluated outcomes. It is fully implemented in Python.

## Structure
- `engine.py`: Core rule evaluation and detection loop engine.
- `enrichment.py`: Functions to enrich data before rule evaluation.
- `rules/`: Directory containing specific detection rules and definitions.
- `sliding_window.py`: Implementation of sliding window aggregation for stream analysis.

## Environment Variables
- `CANARY_KAFKA_BROKERS`: Kafka broker connection string.
- `CANARY_DB_CONN`: PostgreSQL connection string.
- `CANARY_PAGERDUTY_KEY`: PagerDuty integration key.
- `CANARY_SLACK_WEBHOOK`: Slack webhook URL.

## Guidelines
- Write any new detection rules directly in the `rules/` directory following standard interfaces.
- Ensure the rule engine remains highly performant and non-blocking.
- Validate telemetry and events accurately before creating actionable alerts.
