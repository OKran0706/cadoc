import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

test("INV-1: Automation and Logs never appear in the sidebar", () => {
  const sidebar = read("src/components/Sidebar.tsx");
  assert.doesNotMatch(sidebar, /href:\s*["']\/(?:automation|logs)["']/);
});

test("INV-2: the guided tour has no Automation navigation target", () => {
  const guide = read("src/components/SentinelGuide.tsx");
  assert.doesNotMatch(guide, /nav-automation/);
});

test("INV-3: disabled demo routes have no page files", () => {
  for (const route of ["automation", "logs"]) {
    assert.equal(fs.existsSync(`src/app/${route}/page.tsx`), false);
  }
});

test("INV-4: Admin never mounts the Kill Switch control", () => {
  const admin = read("src/app/admin/page.tsx");
  assert.doesNotMatch(admin, /KillSwitchPanel|Activate Kill Switch/);
});
