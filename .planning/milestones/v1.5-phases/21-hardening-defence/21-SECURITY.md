---
phase: 21
slug: hardening-defence
status: verified
threats_open: 0
asvs_level: 1
created: "2026-05-08T11:36:00Z"
---

# Phase 21 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Phase 21 focused on defence-in-depth and architectural hardening (IN-001 to IN-006) to ensure long-term system integrity.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Config File | /etc/canary/sentinel.yaml | Local configuration loading |
| Canary Dirs | /var/lib/canary/deployments | Local filesystem protection |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status |
|-----------|----------|-----------|-------------|------------|--------|
| T-21-01 | Tampering | Config Loader | mitigate | Added mandatory validation for critical fields (URL, KeySource) in config.go (IN-005) | closed |
| T-21-02 | Information Disclosure | Deployer | mitigate | Restricted canary directory permissions to 0700 to prevent local browsing (IN-006) | closed |
| T-21-03 | Spoofing | Deployer | mitigate | Forced fast-fail on entropy exhaustion to prevent predictable canary keys (IN-003) | closed |
| T-21-04 | Denial of Service | Aggregator | mitigate | Prevented event buffer key collisions via unique fallback IDs in extractAuditID (IN-001) | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|

*No accepted risks.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-05-08 | 4 | 4 | 0 | gsd-security-auditor |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-05-08
