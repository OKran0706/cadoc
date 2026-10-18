import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizeRole, claimRoles, roleGrants } from "../src/lib/roles.ts";

// The server must classify roles exactly like the UI does (single source of truth, no drift).
test("roles: normalizeRole keeps the UI's rules", () => {
  const cases = {
    "platform_owner": "platform_owner",
    "tenant-admin": "tenant-admin",
    "security-analyst": "security-analyst",
    "read-only": "read-only",
    " Tenant-Admin ": "tenant-admin",
    "superadmin": "platform_owner",
    "global_admin": "platform_owner",
    "owner": "platform_owner",
    "admin": "tenant-admin",
    "company_admin": "tenant-admin",
    "analyst": "security-analyst",
    "operator": "security-analyst",
    "viewer": "read-only",
    "auditor": "read-only",
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(normalizeRole(input), want, input);
  for (const bad of ["wizard", "", "   ", null, undefined, 42, {}]) assert.equal(normalizeRole(bad), null, String(bad));
});

test("roles: authService delegates to the shared implementation instead of duplicating it", () => {
  const src = fs.readFileSync("src/services/authService.ts", "utf8");
  assert.ok(src.includes("export function normalizeRole"), "still exported (INV-ROLE-2)");
  assert.ok(src.includes('from "@/lib/roles"'), "uses the shared module");
  assert.ok(!/r\.includes\("superadmin"\)/.test(src), "rules live in one place");
});

test("roles: claimRoles reads every claim shape the login flow understands", () => {
  assert.deepEqual(claimRoles({ role: "tenant-admin" }), ["tenant-admin"]);
  assert.deepEqual(claimRoles({ roles: ["read-only", "tenant-admin"] }), ["read-only", "tenant-admin"]);
  assert.deepEqual(claimRoles({ role_name: "admin" }), ["admin"]);
  assert.deepEqual(claimRoles({ user_role: "viewer" }), ["viewer"]);
  assert.deepEqual(claimRoles({ realm_access: { roles: ["analyst"] } }), ["analyst"]);
  assert.deepEqual(claimRoles({ role: "a", roles: ["a", "b"] }), ["a", "b"], "de-duplicated");
  assert.deepEqual(claimRoles({}), []);
  assert.deepEqual(claimRoles({ role: 5, roles: [1, null, "ok"], realm_access: "x" }), ["ok"], "non-strings ignored");
  assert.ok(claimRoles({ roles: Array.from({ length: 100 }, (_, i) => `r${i}`) }).length <= 10, "bounded");
  assert.ok(claimRoles({ role: "x".repeat(500) }).every((r) => r.length <= 64), "bounded");
});

test("roles: roleGrants answers determined/allowed, with union semantics", () => {
  assert.deepEqual(roleGrants(["tenant-admin"], "ai.analyze"), { determined: true, allowed: true });
  assert.deepEqual(roleGrants(["platform_owner"], "ai.analyze"), { determined: true, allowed: true });
  assert.deepEqual(roleGrants(["security-analyst"], "ai.analyze"), { determined: true, allowed: false });
  assert.deepEqual(roleGrants(["read-only"], "ai.analyze"), { determined: true, allowed: false });
  assert.deepEqual(roleGrants(["read-only", "admin"], "ai.analyze"), { determined: true, allowed: true }, "any granting role wins");
  assert.deepEqual(roleGrants(["wizard"], "ai.analyze"), { determined: false, allowed: false }, "unknown role string is undetermined, not denied");
  assert.deepEqual(roleGrants([], "ai.analyze"), { determined: false, allowed: false });
});
