import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-SRV-DECOYS-1: ManagedInfrastructure.tsx must fetch decoys and show planted decoys per server
test("INV-SRV-DECOYS-1: ManagedInfrastructure.tsx must integrate decoyService and show decoys per server", () => {
  const content = fs.readFileSync("src/components/ManagedInfrastructure.tsx", "utf8");
  assert.ok(
    content.includes("decoyService") && content.includes("listDecoys"),
    "ManagedInfrastructure must import and invoke decoyService.listDecoys()"
  );
  assert.ok(
    content.includes("decoy") || content.includes("Decoy") || content.includes("canaries"),
    "ManagedInfrastructure must display planted decoys badge or list per server"
  );
});

// INV-SRV-DECOYS-2: ManagedInfrastructure.tsx must show servers currently online
test("INV-SRV-DECOYS-2: ManagedInfrastructure.tsx must show currently online servers and online count", () => {
  const content = fs.readFileSync("src/components/ManagedInfrastructure.tsx", "utf8");
  assert.ok(
    content.includes("online") || content.includes("Online"),
    "ManagedInfrastructure must display online server status"
  );
  assert.ok(
    content.includes("servers") && (content.includes("merged") || content.includes("allServers") || content.includes("combined") || content.includes("nodes")),
    "ManagedInfrastructure must display registered servers and online telemetry nodes"
  );
});

// INV-SRV-DECOYS-3: src/app/infrastructure/page.tsx must integrate decoyService and display planted decoys per server
test("INV-SRV-DECOYS-3: src/app/infrastructure/page.tsx must fetch decoys and display planted decoys per server", () => {
  const content = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  assert.ok(
    content.includes("decoyService"),
    "Infrastructure page must import decoyService"
  );
  assert.ok(
    content.includes("decoyService.listDecoys"),
    "Infrastructure page must call decoyService.listDecoys()"
  );
  assert.ok(
    content.includes("Planted Decoy") || content.includes("planted") || content.includes("decoys"),
    "Infrastructure page must display decoys planted as per the servers"
  );
});

// INV-SRV-DECOYS-4: Infrastructure page must have dedicated server decoys breakdown
test("INV-SRV-DECOYS-4: src/app/infrastructure/page.tsx must provide a Planted Decoys by Server matrix", () => {
  const content = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  assert.ok(
    content.includes("Planted Decoys") || content.includes("Decoys Planted") || content.includes("Server Decoy"),
    "Infrastructure page must contain a dedicated Planted Decoys by Server section"
  );
  assert.ok(
    content.includes("file_path") || content.includes("decoy_type"),
    "Infrastructure page must render decoy file_path and decoy_type"
  );
});

// INV-SRV-DECOYS-5: src/app/infrastructure/page.tsx must provide dedicated tab for all decoys
test("INV-SRV-DECOYS-5: src/app/infrastructure/page.tsx must provide a tab switcher including a dedicated Decoys tab", () => {
  const content = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  assert.ok(
    content.includes("activeTab") || content.includes("tab === 'decoys'") || content.includes('activeTab === "decoys"'),
    "Infrastructure page must support tab state for switching to decoys"
  );
  assert.ok(
    content.includes("Planted Decoys") || content.includes("Decoys"),
    "Infrastructure page must render a dedicated tab button for Decoys"
  );
});

// INV-SRV-DECOYS-6: Infrastructure components must dynamically unify registered servers without hardcoded arrays
test("INV-SRV-DECOYS-6: Infrastructure components must dynamically unify registered servers from serverService without hardcoding", () => {
  const infraContent = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  const managedContent = fs.readFileSync("src/components/ManagedInfrastructure.tsx", "utf8");
  assert.ok(
    !infraContent.includes("KNOWN_REGISTERED_SERVERS"),
    "Infrastructure page must not use a static KNOWN_REGISTERED_SERVERS array"
  );
  assert.ok(
    !managedContent.includes("KNOWN_REGISTERED_SERVERS"),
    "ManagedInfrastructure must not use a static KNOWN_REGISTERED_SERVERS array"
  );
  assert.ok(
    infraContent.includes("serverService.listServers") && managedContent.includes("serverService.listServers"),
    "Infrastructure components must query serverService.listServers dynamically"
  );
});

// INV-SRV-DECOYS-7: Infrastructure components must normalize exact decoy statuses (planted, tampered, cleaned_up)
test("INV-SRV-DECOYS-7: Infrastructure page and ManagedInfrastructure must normalize exact decoy status categories", () => {
  const infraContent = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  const managedContent = fs.readFileSync("src/components/ManagedInfrastructure.tsx", "utf8");
  assert.ok(
    infraContent.includes("normalizeDecoyStatus") && infraContent.includes("getDecoyStatusBadge"),
    "Infrastructure page must implement normalizeDecoyStatus and getDecoyStatusBadge"
  );
  assert.ok(
    managedContent.includes("normalizeDecoyStatus") && managedContent.includes("getDecoyStatusBadge"),
    "ManagedInfrastructure must implement normalizeDecoyStatus and getDecoyStatusBadge"
  );
  assert.ok(
    infraContent.includes("cleaned_up") && infraContent.includes("tampered") && infraContent.includes("planted"),
    "Infrastructure page must explicitly handle planted, tampered, and cleaned_up categories"
  );
});

// INV-SRV-DECOYS-8: Decoys tab and server cards must display exact status counts and badges
test("INV-SRV-DECOYS-8: Decoys tab and server cards must display exact counts and badges for planted, tampered, cleaned up", () => {
  const infraContent = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  assert.ok(
    infraContent.includes("decoyStats.planted") && infraContent.includes("decoyStats.tampered") && infraContent.includes("decoyStats.cleanedUp"),
    "Infrastructure page must compute decoyStats with separate planted, tampered, and cleanedUp counters"
  );
  assert.ok(
    infraContent.includes("CLEANED UP") && infraContent.includes("TAMPERED") && infraContent.includes("PLANTED"),
    "Infrastructure page Decoys tab must provide filter buttons for PLANTED, TAMPERED, and CLEANED UP"
  );
});

// INV-SRV-DECOYS-9: src/app/decoys/page.tsx must support exact statuses and render exact badges
test("INV-SRV-DECOYS-9: src/app/decoys/page.tsx must support exact statuses (all, planted, tampered, cleaned_up)", () => {
  const decoysContent = fs.readFileSync("src/app/decoys/page.tsx", "utf8");
  assert.ok(
    decoysContent.includes("normalizeDecoyStatus") && decoysContent.includes("getDecoyStatusBadge"),
    "Decoys page must implement normalizeDecoyStatus and getDecoyStatusBadge"
  );
  assert.ok(
    decoysContent.includes('"planted"') && decoysContent.includes('"tampered"') && decoysContent.includes('"cleaned_up"'),
    "Decoys page must support filter for planted, tampered, and cleaned_up"
  );
  assert.ok(
    decoysContent.includes("stats.cleanedUp") && decoysContent.includes("stats.tampered"),
    "Decoys page must display metrics for Cleaned Up and Tampered decoys"
  );
});
