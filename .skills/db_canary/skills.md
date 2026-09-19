---
name: db_canary
description: Guidelines and instructions for working with the db_canary component
---

# Database Canary Component

## Overview
The `db_canary` component (deployed as `db-listener`) monitors PostgreSQL/MySQL databases for canary transactions and emits state changes as events to Kafka. It is fully implemented in Python.

## Structure
- `listener.py`: The core database listener mechanism.
- `mysql_watcher.py`: Custom logic and watcher for navigating MySQL.
- `setup.sql`: Initialization script to setup necessary DB schema.

## Environment Variables
- `CANARY_DB_CONN`: PostgreSQL connection string.
- `CANARY_KAFKA_BROKERS`: Kafka broker bootstrap servers.

## Guidelines
- Manage database connections via a pool to prevent overwhelming the DB.
- Handle Kafka producer failures gracefully and log appropriately.
- Use structured logging to simplify observability.
