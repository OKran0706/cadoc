import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-RBAC-P4-1: src/app/admin/page.tsx imports usePermissions and checks platform admin status
test("INV-RBAC-P4-1: src/app/admin/page.tsx must import usePermissions and check isPlatformAdmin", () => {
  const content = fs.readFileSync("src/app/admin/page.tsx", "utf8");
  assert.ok(
    content.includes("usePermissions"),
    "Admin page must import usePermissions"
  );
  assert.ok(
    content.includes("isPlatformAdmin"),
    "Admin page must check isPlatformAdmin"
  );
});

// INV-RBAC-P4-2: src/app/admin/page.tsx renders Client Organizations section via adminService.listClients
test("INV-RBAC-P4-2: src/app/admin/page.tsx must call adminService.listClients and render client organizations", () => {
  const content = fs.readFileSync("src/app/admin/page.tsx", "utf8");
  assert.ok(
    content.includes("adminService.listClients"),
    "Admin page must call adminService.listClients"
  );
  assert.ok(
    content.includes("Client Organizations") || content.includes("Client Tenants"),
    "Admin page must render Client Organizations title"
  );
});

// INV-RBAC-P4-3: src/app/admin/page.tsx provides tenant provisioning modal via onboardingService.provisionTenant
test("INV-RBAC-P4-3: src/app/admin/page.tsx must provide tenant provisioning modal via onboardingService.provisionTenant", () => {
  const content = fs.readFileSync("src/app/admin/page.tsx", "utf8");
  assert.ok(
    content.includes("onboardingService"),
    "Admin page must import onboardingService"
  );
  assert.ok(
    content.includes("onboardingService.provisionTenant"),
    "Admin page must call onboardingService.provisionTenant"
  );
});

// INV-RBAC-P4-4: src/app/admin/page.tsx provides client detail inspection via adminService.getClient
test("INV-RBAC-P4-4: src/app/admin/page.tsx must support inspecting client details via adminService.getClient", () => {
  const content = fs.readFileSync("src/app/admin/page.tsx", "utf8");
  assert.ok(
    content.includes("adminService.getClient"),
    "Admin page must call adminService.getClient for deep diagnostics"
  );
});
