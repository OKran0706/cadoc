import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("INV-SORT-1: ManagedInfrastructure.tsx must sort online servers to the top of mergedServersList", () => {
  const content = fs.readFileSync("src/components/ManagedInfrastructure.tsx", "utf8");
  assert.ok(
    content.includes("list.sort((a, b) =>"),
    "ManagedInfrastructure must sort mergedServersList"
  );
  assert.ok(
    content.includes("a.isOnline && !b.isOnline"),
    "ManagedInfrastructure must prioritize isOnline=true at the top"
  );
});

test("INV-SORT-2: Infrastructure page.tsx must sort online servers to the top of unifiedServers", () => {
  const content = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  assert.ok(
    content.includes("list.sort((a, b) =>"),
    "Infrastructure page must sort unifiedServers"
  );
  assert.ok(
    content.includes("a.isOnline && !b.isOnline"),
    "Infrastructure page must prioritize isOnline=true at the top"
  );
});

test("INV-SORT-3: Sort logic places online servers before offline servers", () => {
  const servers = [
    { hostname: "srv-offline", isOnline: false },
    { hostname: "srv-online-2", isOnline: true },
    { hostname: "srv-online-1", isOnline: true },
  ];
  const sorted = [...servers].sort((a, b) => {
    if (a.isOnline && !b.isOnline) return -1;
    if (!a.isOnline && b.isOnline) return 1;
    return a.hostname.localeCompare(b.hostname);
  });
  assert.equal(sorted[0].hostname, "srv-online-1");
  assert.equal(sorted[1].hostname, "srv-online-2");
  assert.equal(sorted[2].hostname, "srv-offline");
});
