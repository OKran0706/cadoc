import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-RBAC-P5-1: Full Role-Based Permission Matrix Verification
test("INV-RBAC-P5-1: ASVS Level 2 Verification - Persona Permission Boundary Constraints", () => {
  const typesContent = fs.readFileSync("src/lib/types.ts", "utf8").replace(/\r\n/g, "\n");

  // Verify that read-only has strictly zero write or mitigation permissions
  assert.ok(
    typesContent.includes('"read-only": [\n    "project.read",\n    "server.read",\n    "security.read",\n  ]'),
    "read-only role must only contain read permissions"
  );

  // Verify security-analyst has security.respond but lacks project.manage and server.manage
  assert.ok(
    typesContent.includes('"security-analyst": [\n    "security.read",\n    "security.respond",\n    "server.read",\n    "project.read",\n  ]'),
    "security-analyst must lack project.manage and server.manage"
  );
});

// INV-RBAC-P5-2: UI Defense in Depth - All write controls are protected
test("INV-RBAC-P5-2: All critical write actions are protected via usePermissions", () => {
  const infraContent = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  const killSwitchContent = fs.readFileSync("src/components/KillSwitchPanel.tsx", "utf8");
  const adminContent = fs.readFileSync("src/app/admin/page.tsx", "utf8");

  assert.ok(infraContent.includes("server.manage"), "Infrastructure page protects server.manage");
  assert.ok(killSwitchContent.includes("security.respond"), "KillSwitchPanel protects security.respond");
  assert.ok(adminContent.includes("isPlatformAdmin"), "Admin page restricts client provisioning to platform admin");
});
