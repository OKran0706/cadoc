import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-NODES-1: ManagedInfrastructure must resolve full server ID and avoid partial/slice truncation
test("INV-NODES-1: ManagedInfrastructure.tsx must resolve serverId and render full server ID without slicing", () => {
  const content = fs.readFileSync("src/components/ManagedInfrastructure.tsx", "utf8");

  // Must declare resolution for server ID
  assert.ok(
    content.includes("const serverId =") || content.includes("serverId"),
    "ManagedInfrastructure must resolve serverId"
  );

  // Must display Server ID label
  assert.ok(
    content.includes("Server ID:"),
    "ManagedInfrastructure must display 'Server ID:' label"
  );

  // Must not truncate server ID with slice(0, 8)
  assert.ok(
    !content.includes("node.id.slice(0,") && !content.includes("serverId.slice(0,"),
    "ManagedInfrastructure must not slice server ID"
  );

  // Must support copying full server ID
  assert.ok(
    content.includes("copyServerId"),
    "ManagedInfrastructure must provide copyServerId handler"
  );
});

// INV-NODES-2: NodeInventory schema must include server_id and serverId properties
test("INV-NODES-2: src/lib/types.ts NodeInventory interface must declare server_id and serverId", () => {
  const typesContent = fs.readFileSync("src/lib/types.ts", "utf8");
  assert.ok(
    typesContent.includes("server_id?: string;"),
    "NodeInventory must declare optional server_id"
  );
  assert.ok(
    typesContent.includes("serverId?: string;"),
    "NodeInventory must declare optional serverId"
  );
});

// INV-NODES-3: Infrastructure page must also display full Server ID under hostname
test("INV-NODES-3: src/app/infrastructure/page.tsx must display full Server ID without truncation", () => {
  const content = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  assert.ok(
    content.includes("Server ID:"),
    "Infrastructure page must display 'Server ID:' label"
  );
  assert.ok(
    content.includes("serverId"),
    "Infrastructure page must resolve and render serverId"
  );
  assert.ok(
    !content.includes("n.id.slice(0,") && !content.includes("serverId.slice(0,"),
    "Infrastructure page must not slice server ID"
  );
});
