import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-WORLD-1: holisticData.ts must define the enriched TopologyNode schema
test("INV-WORLD-1: holisticData.ts must define geo, facility, placement, and incident properties", () => {
  assert.ok(
    fs.existsSync("src/lib/holisticData.ts"),
    "src/lib/holisticData.ts must exist"
  );
  const content = fs.readFileSync("src/lib/holisticData.ts", "utf8");
  assert.ok(content.includes("countryCode"), "TopologyNode must include countryCode");
  assert.ok(content.includes("facility"), "TopologyNode must include facility definition");
  assert.ok(content.includes("placement"), "TopologyNode must include floor/rack placement");
  assert.ok(content.includes("attackOrigin"), "TopologyNode must include attackOrigin with lat/lng/ip");
  assert.ok(content.includes("compliance"), "TopologyNode must include compliance tag");
});

// INV-WORLD-2: Canonical 10 nodes must span at least 6 countries
test("INV-WORLD-2: holisticData.ts must cover at least 6 countries across the 10 nodes", () => {
  const content = fs.readFileSync("src/lib/holisticData.ts", "utf8");
  assert.ok(content.includes('"US"') || content.includes("'US'"), "Must include US (Ashburn)");
  assert.ok(content.includes('"DE"') || content.includes("'DE'"), "Must include DE (Frankfurt)");
  assert.ok(content.includes('"IN"') || content.includes("'IN'"), "Must include IN (Mumbai Command Center)");
  assert.ok(content.includes('"GB"') || content.includes("'GB'"), "Must include GB (London)");
  assert.ok(content.includes('"JP"') || content.includes("'JP'"), "Must include JP (Tokyo)");
  assert.ok(content.includes('"BR"') || content.includes("'BR'"), "Must include BR (Sao Paulo)");
});

// INV-WORLD-3: holistic/page.tsx must provide view switcher and sync state
test("INV-WORLD-3: holistic/page.tsx must include [Topology 3D] [World Map] switcher and URL sync", () => {
  const content = fs.readFileSync("src/app/holistic/page.tsx", "utf8");
  assert.ok(
    content.includes("view=") || content.includes("searchParams") || content.includes("viewMode"),
    "holistic/page.tsx must persist view in URL search params"
  );
  assert.ok(
    content.includes("World Map") || content.includes("WorldMap"),
    "holistic/page.tsx must provide World Map switcher option"
  );
  assert.ok(
    content.includes("Topology 3D") || content.includes("Topology"),
    "holistic/page.tsx must provide Topology 3D switcher option"
  );
  assert.ok(
    content.includes("compliance") || content.includes("Compliance"),
    "Forensics HUD must display compliance tag"
  );
});

// INV-WORLD-4: WorldMapView.tsx must support 3 zoom levels with breadcrumbs
test("INV-WORLD-4: WorldMapView.tsx must implement breadcrumbs and Back navigation", () => {
  assert.ok(
    fs.existsSync("src/components/WorldMapView.tsx"),
    "src/components/WorldMapView.tsx must exist"
  );
  const content = fs.readFileSync("src/components/WorldMapView.tsx", "utf8");
  assert.ok(
    content.includes("breadcrumb") || content.includes("zoomLevel") || content.includes("level"),
    "WorldMapView must track zoom/navigation level"
  );
  assert.ok(
    content.includes("Back") || content.includes("ArrowLeft") || content.includes("back"),
    "WorldMapView must provide a Back button to step up levels"
  );
});

// INV-WORLD-5: WorldMapView.tsx must support great-circle telemetry and country tinting
test("INV-WORLD-5: WorldMapView.tsx must render telemetry arcs, shockwaves, and country tinting", () => {
  const content = fs.readFileSync("src/components/WorldMapView.tsx", "utf8");
  assert.ok(
    content.includes("greatCircle") || content.includes("ArcLayer") || content.includes("telemetry"),
    "WorldMapView must generate great-circle arcs"
  );
  assert.ok(
    content.includes("shockwave") || content.includes("pulse") || content.includes("beacon"),
    "WorldMapView must render pulsing shockwaves on tampered hubs"
  );
  assert.ok(
    content.includes("Country") || content.includes("country"),
    "WorldMapView must support country status tinting"
  );
});

// INV-WORLD-6: City extruded buildings and Building cutaway floor slabs
test("INV-WORLD-6: WorldMapView.tsx must render extruded buildings and exploded floor slabs", () => {
  const content = fs.readFileSync("src/components/WorldMapView.tsx", "utf8");
  assert.ok(
    content.includes("floor") || content.includes("slab") || content.includes("cutaway"),
    "WorldMapView must render floor slabs in building cutaway"
  );
  assert.ok(
    content.includes("rack") || content.includes("Rack"),
    "WorldMapView must render node rack blocks"
  );
});

// INV-WORLD-7: Isolation flow and Simulate Tamper Banner
test("INV-WORLD-7: holistic/page.tsx must update banner with city/facility/rack and quarantine node", () => {
  const content = fs.readFileSync("src/app/holistic/page.tsx", "utf8");
  assert.ok(
    content.includes("SIMULATED TAMPERING in") || content.includes("Simulated tamper"),
    "holistic/page.tsx must display updated tamper simulation banner"
  );
  assert.ok(
    content.includes("quarantine") || content.includes("isolated") || content.includes("Isolate"),
    "holistic/page.tsx must isolate node and update status"
  );
});
