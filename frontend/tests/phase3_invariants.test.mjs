import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-P3-1: Infrastructure page imports and invokes nodeService & serverService
test("INV-P3-1: src/app/infrastructure/page.tsx must dynamically fetch nodes and servers via services", () => {
  const content = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  assert.match(
    content,
    /import\s+.*nodeService.*from\s+["']@\/services\/nodeService["']/,
    "Infrastructure page must import nodeService"
  );
  assert.match(
    content,
    /nodeService\.getNodes\(\)/,
    "Infrastructure page must call nodeService.getNodes()"
  );
  assert.doesNotMatch(
    content,
    /const nodes\s*=\s*\[\s*\{\s*id:\s*"NODE-01"/,
    "Infrastructure page must not rely on hardcoded NODE-01 array"
  );
});

// INV-P3-2: Infrastructure page mounts AddServerModal
test("INV-P3-2: src/app/infrastructure/page.tsx must integrate AddServerModal and refresh trigger", () => {
  const content = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  assert.match(
    content,
    /import\s+.*AddServerModal.*from\s+["']@\/components\/AddServerModal["']/,
    "Infrastructure page must import AddServerModal"
  );
  assert.match(
    content,
    /<AddServerModal/,
    "Infrastructure page must render AddServerModal"
  );
});

// INV-P3-3: AddServerModal integrates projectService and serverService
test("INV-P3-3: src/components/AddServerModal.tsx must integrate projectService and serverService", () => {
  const content = fs.readFileSync("src/components/AddServerModal.tsx", "utf8");
  assert.match(
    content,
    /import\s+.*projectService.*from\s+["']@\/services\/projectService["']/,
    "AddServerModal must import projectService"
  );
  assert.match(
    content,
    /import\s+.*serverService.*from\s+["']@\/services\/serverService["']/,
    "AddServerModal must import serverService"
  );
  assert.match(
    content,
    /projectService\s*\.\s*listProjects\(\)/,
    "AddServerModal must fetch available projects"
  );
});

// INV-P3-4: AddServerModal sends status "online" when creating a server
test("INV-P3-4: AddServerModal must create servers with status 'online' rather than 'provisioning'", () => {
  const content = fs.readFileSync("src/components/AddServerModal.tsx", "utf8");
  assert.match(
    content,
    /status:\s*["']online["']/,
    "AddServerModal must send status: 'online' in serverService.createServer payload"
  );
  assert.doesNotMatch(
    content,
    /status:\s*["']provisioning["']/,
    "AddServerModal must not send status: 'provisioning'"
  );
});
