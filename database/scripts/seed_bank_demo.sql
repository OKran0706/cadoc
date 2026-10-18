-- Clean demo tenant for the BFSI pitch: tenant schema + RBAC roles + two users + one project.
-- Deliberately seeds NO servers, agents, decoys or alerts: those come from a real enrollment.
--
-- Usage (password hashes are required and never stored in the repo):
--   psql -v admin_hash="$ADMIN_BCRYPT" -v analyst_hash="$ANALYST_BCRYPT" \
--        [-v tenant_slug=meridian-bank] [-v tenant_name='Meridian Bank'] \
--        [-v admin_email=admin@meridianbank.com] [-v analyst_email=analyst@meridianbank.com] \
--        -f database/scripts/seed_bank_demo.sql
\set ON_ERROR_STOP on

\if :{?admin_hash}
\else
    \echo 'ERROR: pass -v admin_hash=<bcrypt hash> (and -v analyst_hash=<bcrypt hash>)'
    \quit
\endif
\if :{?analyst_hash}
\else
    \echo 'ERROR: pass -v analyst_hash=<bcrypt hash>'
    \quit
\endif
\if :{?tenant_slug}
\else
    \set tenant_slug 'meridian-bank'
\endif
\if :{?tenant_name}
\else
    \set tenant_name 'Meridian Bank'
\endif
\if :{?admin_email}
\else
    \set admin_email 'admin@meridianbank.com'
\endif
\if :{?analyst_email}
\else
    \set analyst_email 'analyst@meridianbank.com'
\endif

SELECT public.provision_tenant(:'tenant_slug', :'tenant_name')
WHERE NOT EXISTS (SELECT 1 FROM public.tenants WHERE slug = :'tenant_slug');

SELECT public.set_tenant_search_path(:'tenant_slug', false) AS active_schema;

INSERT INTO roles (name, permissions)
VALUES
    ('tenant-admin',     '["project.manage", "server.manage", "security.read", "security.respond", "project.read", "server.read", "cmdb.write", "cmdb.read", "admin.manage"]'::jsonb),
    ('security-analyst', '["security.read", "security.respond", "server.read", "project.read", "cmdb.read"]'::jsonb),
    ('read-only',        '["project.read", "server.read", "security.read", "cmdb.read"]'::jsonb)
ON CONFLICT (name) DO UPDATE
SET permissions = EXCLUDED.permissions;

INSERT INTO users (email, display_name, password_hash)
VALUES
    (:'admin_email',   'Meridian Security Admin', :'admin_hash'),
    (:'analyst_email', 'Meridian SOC Analyst',    :'analyst_hash')
ON CONFLICT (email) DO UPDATE
SET display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash;

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r ON (
    (u.email = :'admin_email'   AND r.name = 'tenant-admin')
    OR (u.email = :'analyst_email' AND r.name = 'security-analyst')
)
ON CONFLICT (user_id, role_id) DO NOTHING;

INSERT INTO projects (name, description)
VALUES ('Payments & Treasury', 'SWIFT gateway, payment switch and treasury systems.')
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description;

INSERT INTO public.global_audit_log (tenant_id, event_type, payload)
SELECT id, 'BANK_DEMO_SEED',
       jsonb_build_object('source', 'database/scripts/seed_bank_demo.sql', 'tenant_slug', :'tenant_slug')
FROM public.tenants
WHERE slug = :'tenant_slug';
