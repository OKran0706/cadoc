-- Server fingerprint + alias table (a re-added machine is recognised, merged into its earlier
-- record, and its new sentinel identity aliased to it), plus the 'orphaned' decoy status and
-- 'DUPLICATE_FINGERPRINT' alert type. New tenants get all of this
-- from 001 (provision function). Idempotent.
DO $$
DECLARE
    s text;
BEGIN
    FOR s IN
        SELECT n.nspname FROM pg_namespace n
        WHERE n.nspname LIKE 'client\_%'
          AND EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relname = 'servers')
    LOOP
        EXECUTE format('ALTER TABLE %I.servers ADD COLUMN IF NOT EXISTS fingerprint VARCHAR(64)', s);
        EXECUTE format('CREATE INDEX IF NOT EXISTS servers_fingerprint_idx ON %I.servers (fingerprint)', s);

        EXECUTE format($c$CREATE TABLE IF NOT EXISTS %I.server_aliases (
            alias_id UUID PRIMARY KEY,
            server_id UUID NOT NULL REFERENCES %I.servers(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )$c$, s, s);
        EXECUTE format('CREATE INDEX IF NOT EXISTS server_aliases_server_id_idx ON %I.server_aliases (server_id)', s);

        EXECUTE format('ALTER TABLE %I.canary_decoy_files DROP CONSTRAINT IF EXISTS canary_decoy_files_status_chk', s);
        EXECUTE format($c$ALTER TABLE %I.canary_decoy_files ADD CONSTRAINT canary_decoy_files_status_chk
                          CHECK (status IN ('planted', 'tampered', 'cleaned_up', 'verification_failed', 'orphaned'))$c$, s);

        EXECUTE format('ALTER TABLE %I.tamper_alerts DROP CONSTRAINT IF EXISTS tamper_alerts_event_type_chk', s);
        EXECUTE format($c$ALTER TABLE %I.tamper_alerts ADD CONSTRAINT tamper_alerts_event_type_chk
                          CHECK (event_type IN ('DECOY_TAMPER', 'BINARY_TAMPER', 'AUDITD_RULE_DELETED', 'SYSTEM_INTEGRITY_FAIL', 'DUPLICATE_FINGERPRINT'))$c$, s);
    END LOOP;
END $$;
