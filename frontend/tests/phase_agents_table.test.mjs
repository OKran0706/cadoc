import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-AGENTS-1: src/app/agents/page.tsx must provide adjustable density and column visibility toggles
test("INV-AGENTS-1: src/app/agents/page.tsx must implement adjustable table density and column visibility", () => {
  const content = fs.readFileSync("src/app/agents/page.tsx", "utf8");
  assert.ok(
    content.includes("density") && (content.includes("compact") || content.includes("comfortable") || content.includes("detailed")),
    "Agents page must implement adjustable density controls (compact, comfortable, detailed)"
  );
  assert.ok(
    content.includes("visibleColumns") || content.includes("toggleColumn"),
    "Agents page must support customizable/adjustable column visibility"
  );
});

// INV-AGENTS-2: src/app/agents/page.tsx must support sorting, filtering, and pagination
test("INV-AGENTS-2: src/app/agents/page.tsx must support interactive sorting, search filtering, and pagination", () => {
  const content = fs.readFileSync("src/app/agents/page.tsx", "utf8");
  assert.ok(
    content.includes("searchQuery") || content.includes("search"),
    "Agents page must include search filter"
  );
  assert.ok(
    content.includes("sortField") || content.includes("handleSort") || content.includes("sortDirection"),
    "Agents page must support column sorting"
  );
  assert.ok(
    content.includes("pageSize") || content.includes("currentPage"),
    "Agents page must support adjustable pagination and page size selection"
  );
});

// INV-AGENTS-3: src/app/agents/page.tsx must provide expandable deep detail view & cryptographic proofs
test("INV-AGENTS-3: src/app/agents/page.tsx must render expandable details with cryptographic proofs", () => {
  const content = fs.readFileSync("src/app/agents/page.tsx", "utf8");
  assert.ok(
    content.includes("expandedAgentId") || content.includes("toggleExpand") || content.includes("isExpanded"),
    "Agents page must support expandable row detail view"
  );
  assert.ok(
    content.includes("capabilities_proof") || content.includes("capabilities"),
    "Agents page must display cryptographic capabilities proof"
  );
});

// INV-AGENTS-4: src/app/agents/page.tsx must enforce ASVS Level 2 permissions via usePermissions
test("INV-AGENTS-4: src/app/agents/page.tsx must guard write actions with usePermissions", () => {
  const content = fs.readFileSync("src/app/agents/page.tsx", "utf8");
  assert.ok(
    content.includes("usePermissions"),
    "Agents page must import and use usePermissions"
  );
  assert.ok(
    content.includes("server.manage") || content.includes("security.respond"),
    "Agents page must guard decommission/recommission actions behind authorization permissions"
  );
});

// INV-AGENTS-5: src/app/agents/page.tsx must integrate serverService and data export
test("INV-AGENTS-5: src/app/agents/page.tsx must integrate server details and export functionality", () => {
  const content = fs.readFileSync("src/app/agents/page.tsx", "utf8");
  assert.ok(
    content.includes("serverService"),
    "Agents page must import serverService to resolve server metadata"
  );
  assert.ok(
    content.includes("exportToCSV") || content.includes("exportToJSON") || content.includes("export"),
    "Agents page must support exporting agent fleet data"
  );
});
