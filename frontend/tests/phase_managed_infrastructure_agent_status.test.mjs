import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("INV-1: online Managed Infrastructure cards show Agent Online", () => {
  const content = fs.readFileSync("src/components/ManagedInfrastructure.tsx", "utf8");
  const badge = content.match(/function statusBadge\(status: string\) \{([\s\S]*?)\n\}/)?.[1];

  assert.ok(badge, "Managed Infrastructure status badge must exist");
  assert.match(badge, /s === "online" \|\| s === "active" \|\| s === "healthy"/);
  assert.match(badge, /animate-pulse" \/> Agent Online/);
});

test("INV-2: Managed Infrastructure count names agent servers with correct plurality", () => {
  const content = fs.readFileSync("src/components/ManagedInfrastructure.tsx", "utf8");

  assert.match(content, /\{onlineServersCount\} Agent Server\{onlineServersCount === 1 \? "" : "s"\}/);
});
