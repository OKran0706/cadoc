import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-RBAC-P2-1: src/app/infrastructure/page.tsx guards + Add Server behind server.manage permission
test("INV-RBAC-P2-1: src/app/infrastructure/page.tsx must use usePermissions and guard server.manage", () => {
  const content = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  assert.ok(
    content.includes("usePermissions"),
    "Infrastructure page must import and call usePermissions"
  );
  assert.ok(
    content.includes("server.manage"),
    "Infrastructure page must check server.manage permission"
  );
});

// INV-RBAC-P2-2: src/components/KillSwitchPanel.tsx must check security.respond permission
test("INV-RBAC-P2-2: src/components/KillSwitchPanel.tsx must guard emergency trigger behind security.respond", () => {
  const content = fs.readFileSync("src/components/KillSwitchPanel.tsx", "utf8");
  assert.ok(
    content.includes("usePermissions"),
    "KillSwitchPanel must import and use usePermissions"
  );
  assert.ok(
    content.includes("security.respond"),
    "KillSwitchPanel must guard activation with security.respond"
  );
});

// INV-RBAC-P2-3: src/components/Topnav.tsx must display role badges and permission pills
test("INV-RBAC-P2-3: src/components/Topnav.tsx must render role badges and permissions in user drawer", () => {
  const content = fs.readFileSync("src/components/Topnav.tsx", "utf8");
  assert.ok(
    content.includes("usePermissions"),
    "Topnav must import and use usePermissions"
  );
  assert.ok(
    content.includes("permissions"),
    "Topnav must display user permissions"
  );
});
