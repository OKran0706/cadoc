import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const EXPECTED_BACKEND_HOST = "https://ec2-3-89-18-5.compute-1.amazonaws.com";

// INV-P1-1: Environment variable points to AWS EC2 backend
test("INV-P1-1: .env.local must define NEXT_PUBLIC_API_URL pointing to AWS EC2 backend", () => {
  const envContent = fs.readFileSync(".env.local", "utf8");
  assert.match(
    envContent,
    new RegExp(`NEXT_PUBLIC_API_URL=${EXPECTED_BACKEND_HOST}`),
    "NEXT_PUBLIC_API_URL in .env.local must match AWS EC2 backend URL"
  );
  assert.match(
    envContent,
    /NODE_TLS_REJECT_UNAUTHORIZED=0/,
    "NODE_TLS_REJECT_UNAUTHORIZED=0 must be present in .env.local"
  );
});

// INV-P1-2: Proxy route handler fallback and trailing slash preservation
test("INV-P1-2: API v1 proxy route must default to EC2 backend and force trailing slashes for collections", () => {
  const routeContent = fs.readFileSync("src/app/api/v1/[...path]/route.ts", "utf8");
  assert.ok(
    routeContent.includes(EXPECTED_BACKEND_HOST),
    "Proxy route fallback URL must be AWS EC2 backend"
  );
  
  // Verify trailing slash paths include projects, servers, agents, decoys, keys, admins
  const requiredCollections = ["projects", "servers", "agents", "decoys", "keys", "admins"];
  for (const col of requiredCollections) {
    assert.ok(
      routeContent.includes(`"${col}"`),
      `forceTrailingSlashPaths must include "${col}"`
    );
  }
});

// INV-P1-3: Health route handler fallback points to EC2
test("INV-P1-3: Health route handler fallback must point to AWS EC2 backend", () => {
  const healthContent = fs.readFileSync("src/app/api/health/route.ts", "utf8");
  assert.ok(
    healthContent.includes(EXPECTED_BACKEND_HOST),
    "Health route fallback URL must be AWS EC2 backend"
  );
});

// INV-P1-4: Client API library fallback points to EC2
test("INV-P1-4: src/lib/api.ts fallback must point to AWS EC2 backend", () => {
  const apiContent = fs.readFileSync("src/lib/api.ts", "utf8");
  assert.ok(
    apiContent.includes(EXPECTED_BACKEND_HOST),
    "src/lib/api.ts fallback URL must be AWS EC2 backend"
  );
});

// INV-P1-5: Live connectivity to AWS EC2 Health Check
test("INV-P1-5: Live backend /health check returns healthy AWS EC2 status", async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const res = await fetch(`${EXPECTED_BACKEND_HOST}/health`, { signal: AbortSignal.timeout(3000) });
    assert.equal(res.status, 200, "Health check should return 200 OK");
    const data = await res.json();
    assert.equal(data.status, "healthy");
    assert.equal(data.service, "Cadoc Platform (AWS EC2)");
  } catch (err) {
    if (err.cause?.code === "ECONNREFUSED" || err.name === "TimeoutError") {
      t.skip(`Remote EC2 backend temporarily offline (${err.message})`);
      return;
    }
    throw err;
  }
});

// INV-P1-6: Protected endpoint authentication verification
test("INV-P1-6: Live backend /api/v1/dashboard/summary requires authentication and returns 401", async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const res = await fetch(`${EXPECTED_BACKEND_HOST}/api/v1/dashboard/summary`, { signal: AbortSignal.timeout(3000) });
    assert.equal(res.status, 401, "Protected route must reject unauthenticated requests with 401");
    const data = await res.json();
    assert.equal(data.detail, "Missing administrative credentials");
  } catch (err) {
    if (err.cause?.code === "ECONNREFUSED" || err.name === "TimeoutError") {
      t.skip(`Remote EC2 backend temporarily offline (${err.message})`);
      return;
    }
    throw err;
  }
});
