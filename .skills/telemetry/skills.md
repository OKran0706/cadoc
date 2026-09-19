---
name: telemetry
description: Guidelines and instructions for working with the telemetry component
---

# Telemetry Component

## Overview
The `telemetry` component acts as the centralized gathering and exporting mechanism for tracking system-wide metrics, distributed traces, and aggregated logs. It is implemented in Go.

## Structure
- `cmd/`: Root execution contexts and setup logic.
- `internal/`: Handlers, exporters, and the main telemetry pipeline processors.

## Build and Run
- Use the standard Go compiler and toolchain.
- Typically run alongside other microservices to ingest observability data.

## Guidelines
- Adhere firmly to the OpenTelemetry (OTel) or Prometheus standard metrics formats.
- Pre-allocate resources and limit excessive memory creation on the hot ingest paths to ensure fast throughput.
- Support configuration flexibility exclusively via environment variables.
