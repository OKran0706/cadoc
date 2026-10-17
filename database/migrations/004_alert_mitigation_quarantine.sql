-- Process quarantine state on alert_mitigations in every existing tenant schema.
-- New tenants get these columns from 001 (provision function). Idempotent.
-- status is NULL for legacy notes-only mitigations; quarantine flow sets
-- QUARANTINE_REQUESTED -> QUARANTINED | QUARANTINE_FAILED.
DO $$
DECLARE
    s text;
BEGIN
    FOR s IN
        SELECT n.nspname FROM pg_namespace n
        WHERE n.nspname LIKE 'client\_%'
          AND EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relname = 'alert_mitigations')
    LOOP
        EXECUTE format($c$ALTER TABLE %I.alert_mitigations
            ADD COLUMN IF NOT EXISTS status TEXT,
            ADD COLUMN IF NOT EXISTS target_pid INT,
            ADD COLUMN IF NOT EXISTS target_exe TEXT,
            ADD COLUMN IF NOT EXISTS target_comm TEXT,
            ADD COLUMN IF NOT EXISTS result_msg TEXT$c$, s);
    END LOOP;
END $$;
