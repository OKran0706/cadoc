---
name: alert_response
description: Guidelines and instructions for working with the alert_response component
---

# Alert Response Component

## Overview
The `alert_response` component is responsible for routing and dispatching alerts to external systems such as PagerDuty and Slack. It is a Python-based service.

## Structure
- `pagerduty.py`: Integration with the PagerDuty API.
- `slack.py`: Integration with Slack webhooks.
- `router.py`: Core routing and dispatch logic.
- `response/`: Directory for specific response handlers.

## Guidelines
- Write modular code, keeping separate integrations isolated.
- Ensure all external API calls have appropriate timeouts and retry logic.
- Avoid logging sensitive credentials like webhook URLs or API keys.
- Write unit tests using `pytest` or similar framework.
