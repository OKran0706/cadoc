import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-ROLE-1: TokenResponse schema in src/lib/types.ts must support role field
test("INV-ROLE-1: src/lib/types.ts TokenResponse must support role, roles, and user fields", () => {
  const typesContent = fs.readFileSync("src/lib/types.ts", "utf8");
  assert.match(
    typesContent,
    /export interface TokenResponse\s*\{[\s\S]*?role\??:\s*string/,
    "TokenResponse must declare optional role"
  );
  assert.ok(
    typesContent.includes("user?:"),
    "TokenResponse must declare optional user object"
  );
});

// INV-ROLE-2: authService.ts must export normalizeRole and resolveUserRole
test("INV-ROLE-2: src/services/authService.ts must export normalizeRole and resolveUserRole", () => {
  const content = fs.readFileSync("src/services/authService.ts", "utf8");
  assert.ok(
    content.includes("export function normalizeRole"),
    "authService.ts must export normalizeRole"
  );
  assert.ok(
    content.includes("export function resolveUserRole"),
    "authService.ts must export resolveUserRole"
  );
});

// INV-ROLE-3: resolveUserRole must prioritize role directly from login API response
test("INV-ROLE-3: resolveUserRole in authService.ts must prioritize role from login API response", () => {
  const content = fs.readFileSync("src/services/authService.ts", "utf8");
  assert.ok(
    content.includes("apiResponse?.role") || content.includes("directApiRole"),
    "resolveUserRole must inspect role from login API response"
  );
  assert.ok(
    content.includes("normalizedFromApi"),
    "resolveUserRole must prioritize normalizedFromApi before fallbacks"
  );
});

// INV-ROLE-4: loginUser must pass API response to resolveUserRole
test("INV-ROLE-4: loginUser in authService.ts must forward login API data into resolveUserRole", () => {
  const content = fs.readFileSync("src/services/authService.ts", "utf8");
  assert.ok(
    content.includes("resolveUserRole(email, slug, payload, data)"),
    "loginUser must pass data to resolveUserRole"
  );
});

// INV-ROLE-5: getSessionUser in authService must strictly preserve the stored role
test("INV-ROLE-5: src/services/authService.ts must strictly preserve stored role in getSessionUser", () => {
  const content = fs.readFileSync("src/services/authService.ts", "utf8");
  assert.ok(
    !content.includes('expectedRole !== user.role && expectedRole === "tenant-admin"'),
    "getSessionUser must not overwrite stored role with tenant-admin heuristic"
  );
  assert.ok(
    content.includes("normalizeRole(user.role)"),
    "getSessionUser must normalize and preserve stored role"
  );
});
