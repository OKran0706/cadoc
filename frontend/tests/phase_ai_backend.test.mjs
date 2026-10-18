import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpBackend } from "../src/lib/ai/backend.ts";
import { createHandlers } from "../src/lib/ai/handlers.ts";
import { createSessionStore } from "../src/lib/ai/sessions.ts";
import { createRateLimiter, createConcurrencyGate } from "../src/lib/ai/rateLimit.ts";
import { createAuditLog } from "../src/lib/ai/audit.ts";
import { NOW } from "./helpers/ai-fakes.mjs";

const TOKEN = "header.payload.sig-SECRET-TOKEN";

// ── Diagnostics: the real cause must be visible to operators, never to browsers ──────────
test("backend: a network/TLS failure keeps the cause CODE and the path, but never the token or query", async () => {
  const fetchImpl = async () => {
    const e = new TypeError("fetch failed");
    e.cause = Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    throw e;
  };
  const backend = createHttpBackend({ baseUrl: "https://be.test", token: TOKEN, fetchImpl });
  await assert.rejects(backend.get("/api/v1/servers/", { limit: 1 }), (e) => {
    assert.equal(e.status, 0);
    assert.match(e.message, /GET \/api\/v1\/servers\//);
    assert.match(e.message, /DEPTH_ZERO_SELF_SIGNED_CERT/);
    assert.ok(!e.message.includes(TOKEN) && !e.message.includes("limit=1"));
    return true;
  });
});

test("backend: timeouts and HTTP failures are described distinctly", async () => {
  const timeout = createHttpBackend({ baseUrl: "https://be.test", token: TOKEN, fetchImpl: async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); } });
  await assert.rejects(timeout.get("/api/v1/decoys/"), /timeout/);
  const http500 = createHttpBackend({ baseUrl: "https://be.test", token: TOKEN, fetchImpl: async () => new Response("x", { status: 500 }) });
  await assert.rejects(http500.get("/api/v1/decoys/"), (e) => e.status === 500 && /returned 500/.test(e.message));
});

test("handlers: a backend outage is logged with its cause for operators and masked for the client", async () => {
  const logs = [];
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64({ alg: "x" })}.${b64({ sub: "u1", role: "tenant-admin", exp: NOW / 1000 + 3600 })}.sig`;
  const deadBackend = createHttpBackend({
    baseUrl: "https://be.test",
    token: jwt,
    fetchImpl: async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } });
    },
  });
  const handlers = createHandlers({
    loadConfig: () => ({ ok: true, config: { provider: "gemini", model: "m", apiKey: "k", baseUrl: "", timeoutMs: 1000, maxRetries: 0, maxOutputTokens: 100, tokenBudget: 20000, rateLimitMax: 9, rateLimitWindowSec: 60, maxConcurrent: 2 } }),
    createBackend: () => deadBackend,
    llm: async function* () {},
    sessions: createSessionStore({ now: () => NOW }),
    limiter: createRateLimiter({ max: 9, windowMs: 60_000, now: () => NOW }),
    gate: createConcurrencyGate({ max: 2 }),
    audit: createAuditLog({ now: () => NOW, sink: () => {} }),
    now: () => NOW,
    log: (m) => logs.push(m),
  });
  const res = await handlers.query(new Request("http://x/api/ai-analysis/query", { method: "POST", headers: { authorization: `Bearer ${jwt}` }, body: "{}" }));
  const text = await res.text();
  assert.equal(res.status, 502);
  assert.ok(!text.includes("UNABLE_TO_VERIFY") && !text.includes("be.test"), "client sees only the fixed message");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /backend_unavailable/);
  assert.match(logs[0], /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  assert.match(logs[0], /\/api\/v1\/servers\//, "tenant-admin tokens are authenticated with the tenant-scoped read");
  assert.ok(!logs[0].includes(jwt));
});

// ── Self-signed certificates: scoped opt-in, real TLS handshake ───────────────────────────
function selfSignedPair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tls-"));
  const key = path.join(dir, "k.pem");
  const cert = path.join(dir, "c.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  } catch {
    return null;
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

test("backend: strict TLS rejects a self-signed backend; allowSelfSigned reaches it without touching the process-wide TLS flag", async (t) => {
  const pair = selfSignedPair();
  if (!pair) return t.skip("openssl not available");
  const seen = [];
  const server = https.createServer(pair, (req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ id: "srv-1", hostname: "pikachu" }]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `https://127.0.0.1:${server.address().port}`;
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    const strict = createHttpBackend({ baseUrl, token: TOKEN });
    await assert.rejects(strict.get("/api/v1/servers/"), (e) => e.status === 0 && /CERT|SELF_SIGNED|signature/i.test(e.message), "strict mode must fail on an untrusted certificate");

    const lenient = createHttpBackend({ baseUrl, token: TOKEN, allowSelfSigned: true });
    const data = await lenient.get("/api/v1/servers/", { limit: 5 });
    assert.deepEqual(data, [{ id: "srv-1", hostname: "pikachu" }]);
    assert.equal(seen.at(-1).method, "GET");
    assert.equal(seen.at(-1).url, "/api/v1/servers/?limit=5");
    assert.equal(seen.at(-1).auth, `Bearer ${TOKEN}`);
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before, "must not flip the global TLS flag");

    // and the strict client is still strict afterwards (no leakage between clients)
    await assert.rejects(createHttpBackend({ baseUrl, token: TOKEN }).get("/api/v1/servers/"));
  } finally {
    server.close();
  }
});

test("backend: allowSelfSigned still maps HTTP errors and enforces paths/timeouts", async (t) => {
  const pair = selfSignedPair();
  if (!pair) return t.skip("openssl not available");
  const server = https.createServer(pair, (req, res) => {
    if (req.url.startsWith("/api/v1/slow")) return; // never answers
    res.writeHead(req.url.startsWith("/api/v1/forbidden") ? 403 : 200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const backend = createHttpBackend({ baseUrl: `https://127.0.0.1:${server.address().port}`, token: TOKEN, allowSelfSigned: true, timeoutMs: 300 });
  try {
    await assert.rejects(backend.get("/api/v1/forbidden"), (e) => e.status === 403);
    await assert.rejects(backend.get("/api/v1/slow"), (e) => e.status === 0 && /timeout/.test(e.message));
    await assert.rejects(backend.get("/not-api/x"), (e) => e.status === 400);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
