-- Migration 004: Rename last_heartbeat to last_connected_at in sentinel_agents
-- Renames the column and its index for existing active tenant client schemas.

-- 1. Rename column in client_acme
ALTER TABLE client_acme.sentinel_agents RENAME COLUMN last_heartbeat TO last_connected_at;

-- 2. Rename index in client_acme
ALTER INDEX IF EXISTS client_acme.sentinel_agents_last_heartbeat_idx RENAME TO sentinel_agents_last_connected_at_idx;
