import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-SEC-1: CSP must include script-src, isolation headers, and allow required eval for avatar schema compiler
test("INV-SEC-1: next.config.ts must configure CSP and include isolation headers", () => {
  const content = fs.readFileSync("next.config.ts", "utf8");
  assert.ok(
    content.includes("script-src"),
    "next.config.ts must configure script-src"
  );
  assert.ok(
    content.includes("object-src 'none'"),
    "CSP must define object-src 'none'"
  );
  assert.ok(
    content.includes("base-uri 'self'"),
    "CSP must define base-uri 'self'"
  );
  assert.ok(
    content.includes("Cross-Origin-Opener-Policy"),
    "Headers must include Cross-Origin-Opener-Policy"
  );
  assert.ok(
    content.includes("Cross-Origin-Resource-Policy"),
    "Headers must include Cross-Origin-Resource-Policy"
  );
});

// INV-SEC-2: SSE stream helper in src/lib/api.ts must not append token in query params
test("INV-SEC-2: src/lib/api.ts must not append token in URL query parameter for SSE", () => {
  const content = fs.readFileSync("src/lib/api.ts", "utf8");
  assert.ok(
    !content.includes("?token="),
    "api.ts must not construct event stream URLs with '?token='"
  );
});

// INV-SEC-3: authService.ts must set and clear sentinel_token cookie
test("INV-SEC-3: src/services/authService.ts must set and clear sentinel_token cookie", () => {
  const content = fs.readFileSync("src/services/authService.ts", "utf8");
  assert.ok(
    content.includes("sentinel_token"),
    "authService must manage sentinel_token cookie"
  );
  assert.ok(
    content.includes("document.cookie"),
    "authService must interact with document.cookie"
  );
});

// INV-SEC-4: src/proxy.ts must guard protected routes
test("INV-SEC-4: src/proxy.ts must enforce route protection using sentinel_token cookie", () => {
  assert.ok(
    fs.existsSync("src/proxy.ts") || fs.existsSync("src/middleware.ts"),
    "src/proxy.ts must exist"
  );
  const proxyPath = fs.existsSync("src/proxy.ts") ? "src/proxy.ts" : "src/middleware.ts";
  const content = fs.readFileSync(proxyPath, "utf8");
  assert.ok(
    content.includes("sentinel_token"),
    "proxy must check sentinel_token cookie"
  );
  assert.ok(
    content.includes("/login"),
    "proxy must redirect unauthenticated users to /login"
  );
});

// INV-SEC-5: .dockerignore must ignore all .env* variations
test("INV-SEC-5: .dockerignore must include wildcard .env*", () => {
  const content = fs.readFileSync(".dockerignore", "utf8");
  assert.ok(
    content.includes(".env*"),
    ".dockerignore must contain wildcard .env*"
  );
});

// INV-SEC-6: CLOUD_RUN_DEPLOY.md must document hardened ingress setting
test("INV-SEC-6: CLOUD_RUN_DEPLOY.md must document --ingress internal-and-cloud-load-balancing", () => {
  const content = fs.readFileSync("CLOUD_RUN_DEPLOY.md", "utf8");
  assert.ok(
    content.includes("internal-and-cloud-load-balancing"),
    "CLOUD_RUN_DEPLOY.md must document internal-and-cloud-load-balancing ingress"
  );
});
