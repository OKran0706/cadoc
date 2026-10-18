import test from "node:test";
import assert from "node:assert/strict";
import { collectData, resolveServers } from "../src/lib/ai/collect.ts";
import { makeBackend, defaultRoutes, decoy, alert, httpError, iso, SERVERS } from "./helpers/ai-fakes.mjs";

const range = { from: iso(180), to: iso(0) };
const pika = [{ id: "srv-pikachu", hostname: "pikachu" }];
const run = (backend, over = {}) =>
  collectData({
    backend,
    servers: pika,
    range,
    sources: ["decoy_events", "tamper_history", "forensic_findings", "system_logs"],
    filters: {},
    ...over,
  });

// INV-AI-2
test("INV-AI-2: resolveServers only returns servers the caller's token can list", async () => {
  const backend = makeBackend(defaultRoutes());
  const out = await resolveServers(backend, ["srv-pikachu", "srv-eevee"]);
  assert.deepEqual(out.map((s) => s.hostname), ["pikachu", "eevee"]);
});

test("INV-AI-2: an id the backend did not return is a 404 server_not_found (cross-tenant IDOR)", async () => {
  const backend = makeBackend(defaultRoutes());
  await assert.rejects(resolveServers(backend, ["srv-pikachu", "srv-OTHER-TENANT"]), (e) => e.code === "server_not_found" && e.status === 404);
});

test("INV-AI-2: servers can also be addressed by hostname, resolved only within the caller's list", async () => {
  const out = await resolveServers(makeBackend(defaultRoutes()), ["Pikachu"]);
  assert.equal(out[0].id, "srv-pikachu");
});

// INV-AI-12
test("INV-AI-12: collection only ever issues reads", async () => {
  const backend = makeBackend(defaultRoutes());
  await run(backend);
  assert.ok(backend.calls.length >= 3);
  assert.ok(backend.calls.every((c) => c.method === "GET"));
  assert.deepEqual(Object.keys(backend).sort(), ["calls", "get"], "collector is handed a get-only surface");
});

test("collect: tags records with hostname and kind, filters by server and time range", async () => {
  const routes = defaultRoutes();
  routes["/api/v1/decoys/"] = [
    decoy({ id: "in", planted_at: iso(100), last_verified: iso(50), updated_at: iso(50) }),
    decoy({ id: "ancient", planted_at: iso(99999), last_verified: iso(99990), updated_at: iso(99990) }),
    decoy({ id: "other-server", server_id: "srv-eevee" }),
  ];
  routes["/api/v1/dashboard/alerts"] = {
    data: [alert({ id: "a-in", detected_at: iso(10) }), alert({ id: "a-old", detected_at: iso(99999) }), alert({ id: "a-other", server_id: "srv-eevee" })],
    next_cursor: null,
    has_more: false,
  };
  const { records } = await run(makeBackend(routes), { sources: ["decoy_events", "forensic_findings"] });
  assert.deepEqual(records.map((r) => r.id).sort(), ["a-in", "in"]);
  assert.ok(records.every((r) => r.hostname === "pikachu"));
  assert.deepEqual(new Set(records.map((r) => r.kind)), new Set(["decoy", "finding"]));
});

test("collect: decoy_type and status filters are applied", async () => {
  const routes = defaultRoutes();
  routes["/api/v1/decoys/"] = [
    decoy({ id: "t-ssh", decoy_type: "ssh_key", status: "tampered" }),
    decoy({ id: "p-ssh", decoy_type: "ssh_key", status: "planted" }),
    decoy({ id: "t-env", decoy_type: "env_file", status: "tampered" }),
  ];
  const backend = makeBackend(routes);
  const { records } = await run(backend, { sources: ["decoy_events"], filters: { status: "tampered", decoy_type: "ssh_key" } });
  assert.deepEqual(records.map((r) => r.id), ["t-ssh"]);
});

test("collect: tamper_history alone returns only tampered / verification_failed decoys", async () => {
  const routes = defaultRoutes();
  routes["/api/v1/decoys/"] = [decoy({ id: "ok" }), decoy({ id: "bad", status: "tampered" }), decoy({ id: "vf", status: "verification_failed" })];
  const { records } = await run(makeBackend(routes), { sources: ["tamper_history"] });
  assert.deepEqual(records.map((r) => r.id).sort(), ["bad", "vf"]);
});

test("collect: alerts are paged via cursor and capped with a note", async () => {
  const routes = defaultRoutes();
  let page = 0;
  routes["/api/v1/dashboard/alerts"] = (params) => {
    page++;
    return { data: [alert({ id: `a${page}`, detected_at: iso(5) })], next_cursor: `c${page + 1}`, has_more: true };
  };
  const backend = makeBackend(routes);
  const out = await run(backend, { sources: ["forensic_findings"] });
  const alertCalls = backend.calls.filter((c) => c.path.endsWith("/alerts"));
  assert.ok(alertCalls.length <= 10, "page cap");
  assert.equal(alertCalls[1].params.cursor, "c2");
  assert.ok(out.notes.some((n) => /alert|finding/i.test(n) && /cap|limit/i.test(n)));
});

test("collect: system/auth logs match by server and are optional (unavailable is reported, not fatal)", async () => {
  const routes = defaultRoutes();
  routes["/api/v1/admins/audit-logs"] = [
    { id: "au-1", action: "ssh.login_failed", node_id: "srv-pikachu", timestamp: iso(15), details: { user: "root" } },
    { id: "au-2", action: "ssh.login_failed", node_id: "srv-eevee", timestamp: iso(15) },
    { id: "au-3", action: "old", node_id: "srv-pikachu", timestamp: iso(99999) },
  ];
  const ok = await run(makeBackend(routes), { sources: ["system_logs"] });
  assert.deepEqual(ok.records.map((r) => r.id), ["au-1"]);
  assert.equal(ok.records[0].kind, "audit");

  routes["/api/v1/admins/audit-logs"] = httpError(403);
  const denied = await run(makeBackend(routes), { sources: ["decoy_events", "system_logs"] });
  assert.equal(denied.unavailable.length, 1);
  assert.equal(denied.unavailable[0].source, "system_logs");
  assert.ok(denied.records.length >= 1, "other sources still delivered");
});

test("collect: a failing source never leaks the raw backend error", async () => {
  const routes = defaultRoutes();
  routes["/api/v1/decoys/"] = new Error("connect ECONNREFUSED ec2-3-89-18-5.compute-1.amazonaws.com:443");
  const out = await run(makeBackend(routes), { sources: ["decoy_events"] });
  assert.ok(!JSON.stringify(out.unavailable).includes("ec2-"));
  assert.equal(out.unavailable[0].source, "decoy_events");
});

test("collect: SERVERS fixture sanity", () => assert.equal(SERVERS.length, 2));
