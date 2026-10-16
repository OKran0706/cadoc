---
phase: 33
slug: flow-testing-and-missing-apis-for-platform-service
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-11
---

# Phase 33 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 9.x |
| **Config file** | none |
| **Quick run command** | `.\venv\Scripts\pytest src/platform_service/tests/test_e2e_flows.py` |
| **Full suite command** | `.\venv\Scripts\pytest src/platform_service/tests/` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `.\venv\Scripts\pytest src/platform_service/tests/test_e2e_flows.py`
- **After every plan wave:** Run `.\venv\Scripts\pytest src/platform_service/tests/`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 33-01-T1 | 01 | 1 | PROJ-ROUTE | — | Project creation & listing restricted by role | integration | `.\venv\Scripts\pytest src/platform_service/tests/ -k projects` | ❌ W0 | ⬜ pending |
| 33-01-T2 | 01 | 1 | SERV-ROUTE | — | Server registration & listing restricted by role | integration | `.\venv\Scripts\pytest src/platform_service/tests/ -k servers` | ❌ W0 | ⬜ pending |
| 33-01-T3 | 01 | 1 | AGNT-ROUTE | — | Agent list is queryable inside tenant scope | integration | `.\venv\Scripts\pytest src/platform_service/tests/ -k agents` | ✅ W0 | ⬜ pending |
| 33-01-T4 | 01 | 1 | E2E-FLOWS | — | Full E2E flows (Onboarding, Keys, Join Token) succeed | integration | `.\venv\Scripts\pytest src/platform_service/tests/test_e2e_flows.py` | ❌ W0 | ⬜ pending |
| 33-01-T5 | 01 | 1 | STG-FLOWS | — | Live staging script validates running VM APIs | manual | `vagrant ssh server -c "python3 /vagrant/test-env/verify-platform-flows.py"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing test infrastructure handles pytest running. Test files will be created in this phase.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live VM Staging Verification | STG-FLOWS | Runs on live virtual machine environment | Execute `vagrant ssh server -c "python3 /vagrant/test-env/verify-platform-flows.py"` and check stdout |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-06-11
