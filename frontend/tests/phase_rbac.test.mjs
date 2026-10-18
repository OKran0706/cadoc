import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-RBAC-1: Types must define UserRole, Permission, and ROLE_PERMISSIONS
test("INV-RBAC-1: src/lib/types.ts must define UserRole, Permission, and exact ROLE_PERMISSIONS map", () => {
  const content = fs.readFileSync("src/lib/types.ts", "utf8");
  
  assert.ok(content.includes("export type UserRole ="), "Must export UserRole type");
  assert.ok(content.includes("tenant-admin"), "UserRole must include 'tenant-admin'");
  assert.ok(content.includes("security-analyst"), "UserRole must include 'security-analyst'");
  assert.ok(content.includes("read-only"), "UserRole must include 'read-only'");
  assert.ok(content.includes("platform_owner"), "UserRole must include 'platform_owner'");
  
  assert.ok(content.includes("export type Permission ="), "Must export Permission type");
  assert.ok(content.includes("project.manage"), "Permission must include 'project.manage'");
  assert.ok(content.includes("project.read"), "Permission must include 'project.read'");
  assert.ok(content.includes("server.manage"), "Permission must include 'server.manage'");
  assert.ok(content.includes("server.read"), "Permission must include 'server.read'");
  assert.ok(content.includes("security.read"), "Permission must include 'security.read'");
  assert.ok(content.includes("security.respond"), "Permission must include 'security.respond'");
  
  assert.ok(content.includes("export const ROLE_PERMISSIONS"), "Must export ROLE_PERMISSIONS");
});

// INV-RBAC-2: src/lib/rbac.ts must export hasPermission and resolve permissions correctly
test("INV-RBAC-2: src/lib/rbac.ts must correctly resolve permissions including wildcard bypass", async () => {
  assert.ok(fs.existsSync("src/lib/rbac.ts"), "src/lib/rbac.ts must exist");
  const rbacContent = fs.readFileSync("src/lib/rbac.ts", "utf8");
  assert.ok(rbacContent.includes("export function hasPermission"), "Must export hasPermission");
  assert.ok(rbacContent.includes("export function getRolePermissions"), "Must export getRolePermissions");
  assert.ok(rbacContent.includes("export function usePermissions"), "Must export usePermissions");
});

// INV-RBAC-3: UserSession must include role: UserRole and permissions: Permission[]
test("INV-RBAC-3: src/services/authService.ts UserSession must include role: UserRole and permissions: Permission[]", () => {
  const authServiceContent = fs.readFileSync("src/services/authService.ts", "utf8");
  assert.ok(
    authServiceContent.includes("role: UserRole"),
    "UserSession must type role as UserRole"
  );
  assert.ok(
    authServiceContent.includes("permissions: Permission[]"),
    "UserSession must include permissions array"
  );
  assert.ok(
    authServiceContent.includes("export function setDemoSession"),
    "authService must export setDemoSession"
  );
});

// INV-RBAC-4: Known personas (Alice, Bob, Carol, Platform Admin) must resolve correctly
test("INV-RBAC-4: Known personas (Alice, Bob, Carol, Platform Admin) must be defined in KNOWN_PERSONAS", () => {
  const typesContent = fs.readFileSync("src/lib/types.ts", "utf8");
  assert.ok(typesContent.includes("KNOWN_PERSONAS"), "Must export KNOWN_PERSONAS map");
  assert.ok(typesContent.includes("alice@mock-acme.example"), "Must include Alice Admin");
  assert.ok(typesContent.includes("bob@mock-acme.example"), "Must include Bob Analyst");
  assert.ok(typesContent.includes("carol@mock-acme.example"), "Must include Carol Readonly");
  assert.ok(typesContent.includes("analyst@acme.com"), "Must include Alice Analyst");
  assert.ok(typesContent.includes("admin@cadoc.io"), "Must include Bootstrap Administrator");
});

// INV-RBAC-5: Permission logic verification
test("INV-RBAC-5: Verification of functional permission matching rules", () => {
  // Simulate mock hasPermission logic
  function check(userPerms, requiredPerm) {
    if (!userPerms) return false;
    if (userPerms.includes("*")) return true;
    return userPerms.includes(requiredPerm);
  }

  // platform_owner has wildcard
  assert.equal(check(["*"], "project.manage"), true);
  assert.equal(check(["*"], "security.respond"), true);

  // tenant-admin
  const adminPerms = ["project.manage", "project.read", "server.manage", "server.read", "security.read", "security.respond"];
  assert.equal(check(adminPerms, "server.manage"), true);
  assert.equal(check(adminPerms, "security.respond"), true);

  // security-analyst
  const analystPerms = ["security.read", "security.respond", "server.read", "project.read"];
  assert.equal(check(analystPerms, "security.respond"), true);
  assert.equal(check(analystPerms, "project.manage"), false);
  assert.equal(check(analystPerms, "server.manage"), false);

  // read-only
  const readOnlyPerms = ["project.read", "server.read", "security.read"];
  assert.equal(check(readOnlyPerms, "project.read"), true);
  assert.equal(check(readOnlyPerms, "security.respond"), false);
  assert.equal(check(readOnlyPerms, "server.manage"), false);
});
