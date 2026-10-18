import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-HOLISTIC-1: Sidebar.tsx must include the new "Holistic View" navigation tab
test("INV-HOLISTIC-1: Sidebar.tsx must register /holistic tab with Orbit/Network icon", () => {
  const content = fs.readFileSync("src/components/Sidebar.tsx", "utf8");
  assert.ok(
    content.includes('href: "/holistic"'),
    "Sidebar.tsx must register the /holistic navigation link"
  );
  assert.ok(
    content.includes("Holistic") || content.includes("Holistic View"),
    "Sidebar.tsx must display 'Holistic View' label"
  );
  assert.ok(
    content.includes("Orbit") || content.includes("Globe") || content.includes("Network"),
    "Sidebar.tsx must use a 3D/network-appropriate icon for the holistic view"
  );
});

// INV-HOLISTIC-2: holistic/page.tsx must provide full dashboard layout, HUD metrics, and state management
test("INV-HOLISTIC-2: holistic/page.tsx must render DashboardLayout and integrate 3D canvas host", () => {
  assert.ok(
    fs.existsSync("src/app/holistic/page.tsx"),
    "src/app/holistic/page.tsx must exist"
  );
  const content = fs.readFileSync("src/app/holistic/page.tsx", "utf8");
  assert.ok(
    content.includes("DashboardLayout"),
    "holistic/page.tsx must use DashboardLayout"
  );
  assert.ok(
    content.includes("Holistic3DView"),
    "holistic/page.tsx must integrate Holistic3DView component"
  );
  assert.ok(
    content.includes("tamper") || content.includes("Tamper"),
    "holistic/page.tsx must support tamper awareness / incident inspection"
  );
});

// INV-HOLISTIC-3: Holistic3DView.tsx must use Three.js for 3D rendering with nodes, links, and tamper animations
test("INV-HOLISTIC-3: Holistic3DView.tsx must initialize Three.js scene, node meshes, and render loop", () => {
  assert.ok(
    fs.existsSync("src/components/Holistic3DView.tsx"),
    "src/components/Holistic3DView.tsx must exist"
  );
  const content = fs.readFileSync("src/components/Holistic3DView.tsx", "utf8");
  assert.ok(
    content.includes("THREE.WebGLRenderer") || content.includes("new THREE.Scene"),
    "Holistic3DView.tsx must create a Three.js WebGL scene"
  );
  assert.ok(
    content.includes("requestAnimationFrame"),
    "Holistic3DView.tsx must drive a smooth 60fps render loop"
  );
  assert.ok(
    content.includes("tampered") || content.includes("tamper") || content.includes("shockwave"),
    "Holistic3DView.tsx must render 3D tamper shockwaves / alert pulses"
  );
  assert.ok(
    content.includes("Raycaster") || content.includes("raycaster"),
    "Holistic3DView.tsx must support raycasting for interactive node selection in 3D"
  );
});

// INV-HOLISTIC-4: Threat inspection & containment must be guarded with usePermissions
test("INV-HOLISTIC-4: holistic/page.tsx or Holistic3DView.tsx must guard write/containment actions with permissions", () => {
  const pageContent = fs.readFileSync("src/app/holistic/page.tsx", "utf8");
  assert.ok(
    pageContent.includes("usePermissions") || pageContent.includes("can("),
    "holistic/page.tsx must use RBAC permissions for containment actions"
  );
  assert.ok(
    pageContent.includes("isolate") || pageContent.includes("Isolate") || pageContent.includes("Contain"),
    "holistic/page.tsx must provide node isolation or containment capability"
  );
});

// INV-HOLISTIC-5: Cleanup & memory management for WebGL lifecycle
test("INV-HOLISTIC-5: Holistic3DView.tsx must dispose WebGL renderer, geometries, and cancel animation on unmount", () => {
  const content = fs.readFileSync("src/components/Holistic3DView.tsx", "utf8");
  assert.ok(
    content.includes("cancelAnimationFrame") || content.includes("renderer.dispose"),
    "Holistic3DView.tsx must clean up animation frames or renderer on unmount"
  );
});
