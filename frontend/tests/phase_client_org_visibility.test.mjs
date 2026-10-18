import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizeRole } from "../src/lib/roles.ts";
import { getRolePermissions } from "../src/lib/rbac.ts";

test("INV-5: tenant owner roles never normalize to platform owner", () => {
  for (const role of ["tenant_owner", "tenant-owner", "client_owner", "organization_owner"]) {
    assert.equal(normalizeRole(role), "tenant-admin");
    assert.ok(!getRolePermissions(role).includes("*"));
  }
  assert.equal(normalizeRole("platform_owner"), "platform_owner");
});

test("INV-6: client organizations and actions are platform-owner only", () => {
  const admin = fs.readFileSync("src/app/admin/page.tsx", "utf8");
  assert.match(admin, /const isPlatformAdmin = role === "platform_owner"/);
  assert.match(admin, /isPlatformAdmin \? adminService\.listClients\(\)/);
  assert.match(admin, /if \(user\) loadData\(\)/);
  assert.match(admin, /\{isPlatformAdmin && \(\s*<section[^>]*>/);
  assert.match(admin, /\{isPlatformAdmin && showProvisionModal && \(/);
  assert.match(admin, /\{isPlatformAdmin && inspectingClient && \(/);
  assert.match(admin, /isOpen=\{isPlatformAdmin && showAddServerModal\}/);
});
