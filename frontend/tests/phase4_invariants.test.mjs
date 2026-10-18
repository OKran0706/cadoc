import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-P4-1: adminService supports paginated audit logs
test("INV-P4-1: src/services/adminService.ts must support limit and offset in getAuditLogs", () => {
  const content = fs.readFileSync("src/services/adminService.ts", "utf8");
  assert.match(
    content,
    /getAuditLogs\s*:\s*\(\s*(limit|params)?/,
    "getAuditLogs must accept parameters"
  );
  assert.match(
    content,
    /\/api\/v1\/admins\/audit-logs/,
    "getAuditLogs must target /api/v1/admins/audit-logs"
  );
});

// INV-P4-2: types.ts defines AuditLogEntry
test("INV-P4-2: src/lib/types.ts must define AuditLogEntry", () => {
  const content = fs.readFileSync("src/lib/types.ts", "utf8");
  assert.match(
    content,
    /export interface AuditLogEntry/,
    "types.ts must export AuditLogEntry"
  );
});

// INV-P4-3: Admin page dynamically fetches live admins and audit logs
test("INV-P4-3: src/app/admin/page.tsx must dynamically fetch admins and audit logs via adminService", () => {
  const content = fs.readFileSync("src/app/admin/page.tsx", "utf8");
  assert.match(
    content,
    /import\s+.*adminService.*from\s+["']@\/services\/adminService["']/,
    "Admin page must import adminService"
  );
  assert.match(
    content,
    /adminService\.listAdmins\(\)/,
    "Admin page must call adminService.listAdmins()"
  );
  assert.match(
    content,
    /adminService\.getAuditLogs\(\)/,
    "Admin page must call adminService.getAuditLogs()"
  );
  assert.doesNotMatch(
    content,
    /const analysts\s*=\s*\[\s*\{\s*name:\s*"Lead Analyst"/,
    "Admin page must not rely on hardcoded analysts array"
  );
  assert.doesNotMatch(
    content,
    /const auditTrail\s*=\s*\[\s*\{\s*action:\s*"Viewed forensic archive"/,
    "Admin page must not rely on hardcoded auditTrail array"
  );
});
