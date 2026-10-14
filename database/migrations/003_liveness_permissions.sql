-- Migration 003: Grant necessary table and sequence permissions to canary_monitor for global audit logging.
-- The canary_monitor user requires INSERT permissions on public.global_audit_log
-- and USAGE/SELECT permissions on public.global_audit_log_id_seq.

-- Grant insert permission on global audit log
GRANT INSERT ON public.global_audit_log TO canary_monitor;

-- Grant usage/selection permissions on sequences (such as global_audit_log_id_seq)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO canary_monitor;
