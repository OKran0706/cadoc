import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-P5-1: decoyService accepts status query parameter
test("INV-P5-1: src/services/decoyService.ts must support status parameter in listDecoys", () => {
  const content = fs.readFileSync("src/services/decoyService.ts", "utf8");
  assert.match(
    content,
    /listDecoys\s*:\s*\(\s*(status\??:\s*string)?/,
    "listDecoys must accept status parameter"
  );
  assert.match(
    content,
    /\/api\/v1\/decoys\//,
    "listDecoys must target /api/v1/decoys/"
  );
});

// INV-P5-2: Decoys page dynamically fetches from decoyService
test("INV-P5-2: src/app/decoys/page.tsx must dynamically fetch decoys via decoyService", () => {
  const content = fs.readFileSync("src/app/decoys/page.tsx", "utf8");
  assert.match(
    content,
    /import\s+.*decoyService.*from\s+["']@\/services\/decoyService["']/,
    "Decoys page must import decoyService"
  );
  assert.match(
    content,
    /decoyService\.listDecoys\(\)/,
    "Decoys page must call decoyService.listDecoys()"
  );
  assert.doesNotMatch(
    content,
    /const decoys:\s*DecoyPath\[\]\s*=\s*\[/,
    "Decoys page must not rely on hardcoded decoys array"
  );
});
