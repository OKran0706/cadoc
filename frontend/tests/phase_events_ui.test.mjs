import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-EVENTS-UI-1: src/app/events/page.tsx must resolve hostnames dynamically from alert.hostname, details, servers, and nodes
test("INV-EVENTS-UI-1: getServerInfo must resolve hostnames from top-level hostname, details and node inventory", () => {
  const content = fs.readFileSync("src/app/events/page.tsx", "utf8");
  assert.ok(
    content.includes("hostname ||") || content.includes("explicitHost"),
    "getServerInfo must check top-level alert hostname first"
  );
  assert.ok(
    content.includes("details?.hostname") || content.includes("details?.host"),
    "getServerInfo must check alert details for explicit hostname or host"
  );
  assert.ok(
    content.includes("n.hostname") || content.includes("n.host_name"),
    "getServerInfo must check node.hostname or node.host_name"
  );
});

// INV-EVENTS-UI-2: src/app/events/page.tsx must not contain playful pink/purple vibe-coded tags
test("INV-EVENTS-UI-2: events/page.tsx must replace playful pink/purple tags with enterprise deception badge", () => {
  const content = fs.readFileSync("src/app/events/page.tsx", "utf8");
  assert.ok(
    !content.includes("bg-purple-50 text-purple-700"),
    "events/page.tsx must not use playful purple vibe badge"
  );
  assert.ok(
    !content.includes("<Ghost className"),
    "events/page.tsx must not use playful Ghost icon for security signals"
  );
  assert.ok(
    content.includes("Tripwire") || content.includes("Decoy") || content.includes("DECOY"),
    "events/page.tsx must render enterprise deception badge"
  );
});

// INV-EVENTS-UI-3: src/app/events/page.tsx must provide inline alert inspection instead of blocking right flyout
test("INV-EVENTS-UI-3: events/page.tsx must use inline inspection without blocking right drawer", () => {
  const content = fs.readFileSync("src/app/events/page.tsx", "utf8");
  assert.ok(
    !content.includes("animate-[slideInRight"),
    "events/page.tsx must remove clunky right flyout drawer"
  );
  assert.ok(
    content.includes("expanded") || content.includes("ChevronDown"),
    "events/page.tsx must support inline expansion for alert details"
  );
});
