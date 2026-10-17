-- Allow sentinel_agents.status = 'decommissioned' in every existing tenant schema.
-- New tenants get it from 001 (provision function). Idempotent.
DO $$
DECLARE
    s text;
BEGIN
    FOR s IN
        SELECT n.nspname FROM pg_namespace n
        WHERE n.nspname LIKE 'client\_%'
          AND EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relname = 'sentinel_agents')
    LOOP
        EXECUTE format('ALTER TABLE %I.sentinel_agents DROP CONSTRAINT IF EXISTS sentinel_agents_status_chk', s);
        EXECUTE format($c$ALTER TABLE %I.sentinel_agents ADD CONSTRAINT sentinel_agents_status_chk
                          CHECK (status IN ('active', 'offline', 'degraded', 'decommissioned'))$c$, s);
    END LOOP;
END $$;
