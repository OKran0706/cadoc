---
phase: 31
slug: implement-multi-tenant-auth-updates-consolidate-public-tenan
status: completed
nyquist_compliant: true
wave_0_complete: true
created: 2026-06-11
---

# Phase 31 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 7.x |
| **Config file** | src/platform_service/tests/conftest.py |
| **Quick run command** | `pytest src/platform_service/tests/test_security.py` |
| **Full suite command** | `pytest src/platform_service/tests/` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pytest src/platform_service/tests/test_security.py`
- **After every plan wave:** Run `pytest src/platform_service/tests/`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 31-01-01 | 01 | 1 | AUTH-MIG | T-31-01 | Drop old public auth tables, create global_admins/global_api_keys, update provision_tenant | db-migration | `pytest src/platform_service/tests/test_security.py -k test_auth_migration` | ✅ W0 | ✅ green |
| 31-01-02 | 01 | 1 | KEY-ROUTE | T-31-02 | Route prefix-based API keys to correct schema dynamically | unit | `pytest src/platform_service/tests/test_security.py -k test_api_key_routing` | ✅ W0 | ✅ green |
| 31-01-03 | 01 | 2 | AUTH-LOGIN | T-31-03 | Authenticate both global admins (public) and tenant users (tenant schema) | integration | `pytest src/platform_service/tests/test_security.py -k test_federated_login` | ✅ W0 | ✅ green |
| 31-01-04 | 01 | 2 | RBAC-CHECK | T-31-04 | Enforce global admin bypass and tenant-local role checks | integration | `pytest src/platform_service/tests/test_security.py -k test_federated_permissions` | ✅ W0 | ✅ green |
| 31-01-05 | 01 | 2 | DEP-CLEANUP | T-31-05 | Dropping tenant schema automatically drops all local users, roles, and keys | database | `pytest src/platform_service/tests/test_security.py -k test_tenant_teardown_cleanup` | ✅ W0 | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `src/platform_service/tests/test_security.py` — stubs for testing the consolidated auth migrations, prefix key verification, and federated login logic.
- [x] `database/migrations/006_consolidate_auth_schema.sql` — new migration SQL file.

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 10s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved
