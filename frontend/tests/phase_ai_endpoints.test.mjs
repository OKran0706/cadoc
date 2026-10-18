import test from "node:test";
import assert from "node:assert/strict";
import { createHandlers } from "../src/lib/ai/handlers.ts";
import { createSessionStore } from "../src/lib/ai/sessions.ts";
import { createRateLimiter, createConcurrencyGate } from "../src/lib/ai/rateLimit.ts";
import { createAuditLog } from "../src/lib/ai/audit.ts";
import { AiProviderError } from "../src/lib/ai/provider.ts";
import { makeBackend, defaultRoutes, alert, httpError, readSse, iso, NOW } from "./helpers/ai-fakes.mjs";

const GEMINI_KEY = "AIzaSy-ENDPOINT-SECRET";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims = {}) =>
  `${b64({ alg: "HS256" })}.${b64({ sub: "user-1", email: "ada@acme.io", role: "tenant-admin", company_slug: "acme", exp: NOW / 1000 + 3600, ...claims })}.sig`;
const TOKEN = jwt();

const CONFIG = {
  provider: "gemini", model: "gemini-2.5-flash", apiKey: GEMINI_KEY, baseUrl: "", timeoutMs: 1000, maxRetries: 0,
  maxOutputTokens: 512, tokenBudget: 24000, rateLimitMax: 50, rateLimitWindowSec: 600, maxConcurrent: 2,
  backendUrl: "https://backend.test", adminProbePath: "/api/v1/admins/audit-logs",
};

function fakeLlm(turns) {
  const calls = [];
  const llm = async function* (p) {
    calls.push(JSON.parse(JSON.stringify(p)));
    const turn = turns[Math.min(calls.length - 1, turns.length - 1)];
    if (turn instanceof Error) throw turn;
    for (const e of turn) yield e;
  };
  llm.calls = calls;
  return llm;
}
const ANSWER = [{ type: "text", text: "## Summary\nAll " }, { type: "text", text: "good [dcy-1]" }, { type: "stop", reason: "end_turn" }];

function setup({ routes = defaultRoutes(), turns = [ANSWER], config = CONFIG, limiter, gate } = {}) {
  const backend = makeBackend(routes);
  const tokensSeen = [];
  const llm = fakeLlm(turns);
  const audit = createAuditLog({ now: () => NOW, sink: () => {} });
  const sessions = createSessionStore({ now: () => NOW });
  const handlers = createHandlers({
    loadConfig: () => (config ? { ok: true, config } : { ok: false, code: "ai_not_configured", message: "not configured" }),
    createBackend: (token) => (tokensSeen.push(token), backend),
    llm,
    sessions,
    limiter: limiter ?? createRateLimiter({ max: 50, windowMs: 600_000, now: () => NOW }),
    gate: gate ?? createConcurrencyGate({ max: 2 }),
    audit,
    now: () => NOW,
  });
  return { handlers, backend, llm, audit, sessions, tokensSeen };
}

const body = (over = {}) => ({
  servers: ["srv-pikachu"],
  range: { from: iso(120), to: iso(0) },
  sources: ["decoy_events", "tamper_history", "forensic_findings"],
  filters: {},
  message: "What happened on pikachu in the last 2 hours?",
  ...over,
});
const req = (path, payload, { token = TOKEN, headers = {}, raw } = {}) =>
  new Request(`http://localhost/api/ai-analysis/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? JSON.stringify(payload),
  });
const json = async (res) => JSON.parse(await res.text());
const sseEvents = (text) => text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.replace(/^data:\s*/, "")));

// ── INV-AI-1 ────────────────────────────────────────────────────────────────
test("INV-AI-1: no Authorization header => 401, nothing collected, LLM never called, denial audited", async () => {
  const t = setup();
  const res = await t.handlers.query(req("query", body(), { token: null }));
  assert.equal(res.status, 401);
  assert.equal(t.backend.calls.length, 0);
  assert.equal(t.llm.calls.length, 0);
  assert.equal(t.audit.entries.at(-1).action, "denied");
});

test("INV-AI-1: the session cookie alone is NOT accepted (CSRF defence)", async () => {
  const t = setup();
  const res = await t.handlers.query(req("query", body(), { token: null, headers: { cookie: `sentinel_token=${TOKEN}` } }));
  assert.equal(res.status, 401);
  assert.equal(t.backend.calls.length, 0);
});

test("INV-AI-1: a tenant-admin token is allowed even though the platform-only /admins/audit-logs answers 403 (real deployment case)", async () => {
  const routes = defaultRoutes();
  routes["/api/v1/admins/audit-logs"] = httpError(403); // global_admins endpoint: platform owners only
  const t = setup({ routes });
  const res = await t.handlers.query(req("query", body()));
  assert.equal(res.status, 200);
  await res.text();
  assert.ok(!t.backend.calls.some((c) => c.path === "/api/v1/admins/audit-logs" && c.params.limit === 1), "admin probe is not used when the token states its role");
  assert.ok(t.backend.calls.some((c) => c.path === "/api/v1/servers/"), "token authenticity is proven with a tenant-scoped read");
});

test("INV-AI-1: when the token states NO role, the backend admin probe decides (403 => forbidden with reason=backend)", async () => {
  const routes = defaultRoutes();
  routes["/api/v1/admins/audit-logs"] = httpError(403);
  const t = setup({ routes });
  const res = await t.handlers.query(req("query", body(), { token: jwt({ role: undefined }) }));
  assert.equal(res.status, 403);
  assert.equal((await json(res)).reason, "backend");
  assert.equal(t.backend.calls.length, 1, "only the probe ran");
  assert.equal(t.llm.calls.length, 0);
  assert.equal(t.audit.entries.at(-1).outcome, "forbidden");
  const ok = await setup().handlers.query(req("query", body(), { token: jwt({ role: undefined }) }));
  assert.equal(ok.status, 200, "probe 200 => admin");
  await ok.text();
});

test("INV-AI-1: role claims are read like the UI does: aliases, arrays (union), unknown strings fall back to the probe", async () => {
  const status = async (claims, routes) => {
    const r = await setup({ routes }).handlers.query(req("query", body(), { token: jwt(claims) }));
    await r.text();
    return r.status;
  };
  assert.equal(await status({ role: "admin" }), 200, "alias of tenant-admin");
  assert.equal(await status({ role: undefined, roles: ["read-only", "tenant-admin"] }), 200, "any granting role wins");
  assert.equal(await status({ role: undefined, realm_access: { roles: ["platform_owner"] } }), 200);
  assert.equal(await status({ role: "viewer" }), 403);
  assert.equal(await status({ role: "operator" }), 403);
  assert.equal(await status({ role: "wizard" }), 200, "undetermined role => probe (audit-logs 200 in defaultRoutes)");
  const denied = defaultRoutes();
  denied["/api/v1/admins/audit-logs"] = httpError(403);
  assert.equal(await status({ role: "wizard" }, denied), 403, "undetermined role + probe 403 => forbidden");
});

test("INV-AI-1: a role claim is only trusted after the backend accepts the token (forged admin claim => 401)", async () => {
  const routes = defaultRoutes();
  routes["/api/v1/servers/"] = httpError(401);
  const t = setup({ routes });
  const res = await t.handlers.query(req("query", body()));
  assert.equal(res.status, 401);
  assert.equal(t.llm.calls.length, 0);
  const down = defaultRoutes();
  down["/api/v1/servers/"] = httpError(500);
  assert.equal((await setup({ routes: down }).handlers.query(req("query", body()))).status, 502, "fail closed");
});

test("INV-AI-1: forbidden by role claim tells the client reason=role and never reaches the backend", async () => {
  const t = setup();
  const res = await t.handlers.query(req("query", body(), { token: jwt({ role: "security-analyst" }) }));
  assert.equal(res.status, 403);
  assert.equal((await json(res)).reason, "role");
  assert.equal(t.backend.calls.length, 0);
});

test("INV-AI-1: a token whose claims say read-only is rejected before touching the backend", async () => {
  const t = setup();
  const res = await t.handlers.query(req("query", body(), { token: jwt({ role: "read-only" }) }));
  assert.equal(res.status, 403);
  assert.equal(t.backend.calls.length, 0);
});

test("INV-AI-1: expired or malformed tokens => 401; backend 401 => 401; backend down => 502 (fail closed)", async () => {
  assert.equal((await setup().handlers.query(req("query", body(), { token: jwt({ exp: NOW / 1000 - 10 }) }))).status, 401);
  assert.equal((await setup().handlers.query(req("query", body(), { token: "not.a.jwt!!" }))).status, 401);
  const r401 = defaultRoutes();
  r401["/api/v1/servers/"] = httpError(401);
  assert.equal((await setup({ routes: r401 }).handlers.query(req("query", body()))).status, 401);
  const r500 = defaultRoutes();
  r500["/api/v1/servers/"] = httpError(500);
  assert.equal((await setup({ routes: r500 }).handlers.query(req("query", body()))).status, 502);
});

test("INV-AI-1: the follow-up endpoint is guarded identically", async () => {
  const t = setup();
  const res = await t.handlers.followup(req("followup", { session_id: "x".repeat(8), message: "hi" }, { token: null }));
  assert.equal(res.status, 401);
});

test("INV-AI-1: the caller's own token goes to the backend only, and neither token nor Gemini key goes into LLM messages", async () => {
  const t = setup();
  await (await t.handlers.query(req("query", body()))).text();
  assert.ok(t.tokensSeen.length > 0 && t.tokensSeen.every((x) => x === TOKEN));
  const sent = JSON.stringify(t.llm.calls.map((c) => ({ system: c.system, messages: c.messages, tools: c.tools })));
  assert.ok(!sent.includes(TOKEN));
  assert.ok(!sent.includes(GEMINI_KEY));
});

// ── happy path ──────────────────────────────────────────────────────────────
test("query: streams meta -> deltas -> done and stores the conversation", async () => {
  const t = setup();
  const res = await t.handlers.query(req("query", body()));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  assert.match(res.headers.get("cache-control"), /no-cache/);
  const events = await readSse(res);
  assert.equal(events[0].type, "meta");
  assert.match(events[0].session_id, /^[0-9a-f-]{36}$/);
  assert.equal(events[0].data_used.record_count, 2);
  assert.deepEqual(events[0].data_used.servers, [{ id: "srv-pikachu", hostname: "pikachu" }]);
  assert.equal(events.filter((e) => e.type === "delta").map((e) => e.text).join(""), "## Summary\nAll good [dcy-1]");
  assert.equal(events.at(-1).type, "done");
  const s = t.sessions.get("user-1", events[0].session_id);
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[1].role, "assistant");
  assert.match(t.llm.calls[0].messages[0].content, /<<<UNTRUSTED_LOG_DATA id=/);
  assert.match(t.llm.calls[0].system, /senior security analyst/i);
  assert.equal(t.llm.calls[0].config.provider, "gemini");
});

// ── INV-AI-4 at the endpoint ────────────────────────────────────────────────
test("INV-AI-4: secrets in data AND in the admin's question never reach the LLM", async () => {
  const routes = defaultRoutes();
  routes["/api/v1/dashboard/alerts"] = {
    data: [alert({ details: { password: "hunter2", note: "API_KEY=sk-live-abcdefghijklmnop1234", path: "/srv/.env" } })],
    next_cursor: null, has_more: false,
  };
  const t = setup({ routes });
  await (await t.handlers.query(req("query", body({ message: "why does password=letmein99 show up?" })))).text();
  const sent = JSON.stringify(t.llm.calls.map((c) => c.messages));
  for (const leaked of ["hunter2", "sk-live-abcdef", "letmein99"]) assert.ok(!sent.includes(leaked), `leaked ${leaked}`);
  assert.ok(sent.includes("/srv/.env"));
});

// ── INV-AI-2 ────────────────────────────────────────────────────────────────
test("INV-AI-2: unknown / foreign server => 404 and no LLM call", async () => {
  const t = setup();
  const res = await t.handlers.query(req("query", body({ servers: ["srv-pikachu", "srv-NOT-MINE"] })));
  assert.equal(res.status, 404);
  assert.equal((await json(res)).code, "server_not_found");
  assert.equal(t.llm.calls.length, 0);
});

// ── INV-AI-8 ────────────────────────────────────────────────────────────────
test("INV-AI-8: invalid / privileged payloads => 400 before any backend or LLM work", async () => {
  const t = setup();
  const res = await t.handlers.query(req("query", { ...body(), role: "platform_owner" }));
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, "invalid_request");
  assert.equal((await t.handlers.query(req("query", null, { raw: "{not json" }))).status, 400);
  assert.equal((await t.handlers.query(req("query", null, { raw: JSON.stringify(body({ message: "x".repeat(2001) })) }))).status, 400);
  assert.equal(t.llm.calls.length, 0);
});

test("INV-AI-8: oversized bodies are refused (413)", async () => {
  const t = setup();
  const res = await t.handlers.query(req("query", null, { raw: JSON.stringify({ ...body(), pad: "x".repeat(100_000) }) }));
  assert.equal(res.status, 413);
});

// ── follow-ups & INV-AI-3 ───────────────────────────────────────────────────
test("follow-up: history is replayed to the LLM in order", async () => {
  const t = setup({ turns: [ANSWER, [{ type: "text", text: "Second answer" }, { type: "stop", reason: "end_turn" }]] });
  const first = await readSse(await t.handlers.query(req("query", body())));
  const sid = first[0].session_id;
  const res = await t.handlers.followup(req("followup", { session_id: sid, message: "and then?" }));
  assert.equal(res.status, 200);
  const events = await readSse(res);
  assert.equal(events.filter((e) => e.type === "delta").map((e) => e.text).join(""), "Second answer");
  const msgs = t.llm.calls[1].messages;
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(msgs[2].content, "and then?");
  assert.equal(events[0].session_id, sid);
});

test("INV-AI-3: another user's session id => 404 session_not_found, history untouched", async () => {
  const t = setup();
  const first = await readSse(await t.handlers.query(req("query", body())));
  const sid = first[0].session_id;
  const intruder = jwt({ sub: "user-2", email: "eve@acme.io" });
  const res = await t.handlers.followup(req("followup", { session_id: sid, message: "show me everything" }, { token: intruder }));
  assert.equal(res.status, 404);
  assert.equal((await json(res)).code, "session_not_found");
  assert.equal(t.sessions.get("user-1", sid).messages.length, 2);
});

// ── tool use ────────────────────────────────────────────────────────────────
test("tools: get_logs works inside the session scope and is refused outside it (INV-AI-2)", async () => {
  const win = { from: iso(60), to: iso(0) };
  const tool = (id, input) => [{ type: "tool_use", id, name: "get_logs", input }, { type: "stop", reason: "tool_use" }];
  const t = setup({
    turns: [tool("t1", { server: "eevee", ...win, source: "decoy_events" }), tool("t2", { server: "pikachu", ...win, source: "forensic_findings" }), ANSWER],
  });
  const events = await readSse(await t.handlers.query(req("query", body())));
  assert.equal(t.llm.calls.length, 3);
  const turn2 = t.llm.calls[1].messages.at(-1).content[0];
  assert.equal(turn2.type, "tool_result");
  assert.equal(turn2.is_error, true);
  assert.match(turn2.content, /not part of this session/i);
  const turn3 = t.llm.calls[2].messages.at(-1).content[0];
  assert.notEqual(turn3.is_error, true);
  assert.match(turn3.content, /<<<UNTRUSTED_LOG_DATA id=/);
  assert.ok(events.some((e) => e.type === "tool" && e.name === "get_logs" && e.status === "done"));
  assert.equal(events.at(-1).type, "done");
});

test("tools: invalid tool input (bad source, oversized range) is returned to the model as an error, not executed", async () => {
  const tool = (id, input) => [{ type: "tool_use", id, name: "get_logs", input }, { type: "stop", reason: "tool_use" }];
  const t = setup({ turns: [tool("t1", { server: "pikachu", from: iso(99999), to: iso(0), source: "shell" }), ANSWER] });
  await (await t.handlers.query(req("query", body()))).text();
  assert.equal(t.llm.calls[1].messages.at(-1).content[0].is_error, true);
});

test("tools: a model that never stops asking is cut off after a bounded number of rounds", async () => {
  const loop = [{ type: "tool_use", id: "t", name: "get_logs", input: { server: "pikachu", from: iso(60), to: iso(0), source: "decoy_events" } }, { type: "stop", reason: "tool_use" }];
  const t = setup({ turns: [loop, loop, loop, loop, loop, ANSWER] });
  const events = await readSse(await t.handlers.query(req("query", body())));
  assert.ok(t.llm.calls.length <= 5, `llm called ${t.llm.calls.length}x`);
  assert.equal(t.llm.calls.at(-1).tools.length, 0, "last round forces a plain answer");
  assert.ok(["done", "error"].includes(events.at(-1).type));
});

// ── INV-AI-7 ────────────────────────────────────────────────────────────────
test("INV-AI-7: per-user rate limit => 429 with Retry-After; LLM not called for the blocked request", async () => {
  const t = setup({ limiter: createRateLimiter({ max: 2, windowMs: 600_000, now: () => NOW }) });
  for (let i = 0; i < 2; i++) await (await t.handlers.query(req("query", body()))).text();
  const res = await t.handlers.query(req("query", body()));
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) >= 1);
  assert.equal((await json(res)).code, "rate_limited");
  assert.equal(t.llm.calls.length, 2);
  assert.equal(t.audit.entries.at(-1).outcome, "rate_limited");
  const other = await t.handlers.query(req("query", body(), { token: jwt({ sub: "user-9" }) }));
  assert.equal(other.status, 200);
  await other.text();
});

test("INV-AI-7: concurrent streams per user are capped and the slot frees when the stream ends or is cancelled", async () => {
  const t = setup({ gate: createConcurrencyGate({ max: 1 }) });
  const first = await t.handlers.query(req("query", body()));
  assert.equal(first.status, 200);
  const second = await t.handlers.query(req("query", body()));
  assert.equal(second.status, 429);
  assert.equal((await json(second)).code, "too_many_concurrent");
  await first.text();
  const third = await t.handlers.query(req("query", body()));
  assert.equal(third.status, 200);
  await third.body.cancel();
  const fourth = await t.handlers.query(req("query", body()));
  assert.equal(fourth.status, 200, "cancel released the slot");
  await fourth.text();
});

// ── INV-AI-9 ────────────────────────────────────────────────────────────────
test("INV-AI-9: LLM failures reach the UI as a fixed code + friendly message, with no upstream detail", async () => {
  const t = setup({ turns: [new AiProviderError("provider_unavailable", `internal detail ec2-3-89-18-5 ${GEMINI_KEY}`)] });
  const text = await (await t.handlers.query(req("query", body()))).text();
  assert.ok(!text.includes("ec2-") && !text.includes(GEMINI_KEY) && !text.includes("internal detail"));
  const err = sseEvents(text).at(-1);
  assert.equal(err.type, "error");
  assert.equal(err.code, "provider_unavailable");
  assert.ok(err.message.length > 10);
  assert.equal(t.audit.entries.at(-1).outcome, "error");
});

test("INV-AI-9: unexpected exceptions are masked as internal_error", async () => {
  const t = setup({ turns: [new Error("TypeError: cannot read secret /app/src/lib/x.ts:12")] });
  const text = await (await t.handlers.query(req("query", body()))).text();
  assert.ok(!text.includes("/app/src") && !text.includes("TypeError"));
  assert.match(text, /internal_error/);
});

test("INV-AI-9: backend outage during collection => 502 backend_unavailable without hostnames", async () => {
  const routes = defaultRoutes();
  routes["/api/v1/servers/"] = new Error("connect ECONNREFUSED ec2-3-89-18-5.compute-1.amazonaws.com:443");
  const res = await setup({ routes }).handlers.query(req("query", body()));
  const text = await res.text();
  assert.equal(res.status, 502);
  assert.ok(!text.includes("ec2-"));
  assert.match(text, /backend_unavailable/);
});

test("all selected sources unavailable => 502 data_unavailable (never ask the LLM to analyse nothing)", async () => {
  const routes = defaultRoutes();
  routes["/api/v1/decoys/"] = httpError(500);
  const t = setup({ routes });
  const res = await t.handlers.query(req("query", body({ sources: ["decoy_events"] })));
  assert.equal(res.status, 502);
  assert.equal((await json(res)).code, "data_unavailable");
  assert.equal(t.llm.calls.length, 0);
});

// ── INV-AI-11 ───────────────────────────────────────────────────────────────
test("INV-AI-11: missing Gemini key => 503 ai_not_configured (after auth, before any data is read)", async () => {
  const t = setup({ config: null });
  const res = await t.handlers.query(req("query", body()));
  assert.equal(res.status, 503);
  assert.equal((await json(res)).code, "ai_not_configured");
  assert.equal(t.backend.calls.length, 1, "only the admin probe ran");
  const unauth = await setup({ config: null }).handlers.query(req("query", body(), { token: null }));
  assert.equal(unauth.status, 401, "config state is not disclosed to unauthenticated callers");
});

// ── INV-AI-10 ───────────────────────────────────────────────────────────────
test("INV-AI-10: every outcome is audited with actor, servers, scope and no secrets", async () => {
  const t = setup();
  const events = await readSse(await t.handlers.query(req("query", body({ message: "password=letmein99 summary please" }))));
  await (await t.handlers.followup(req("followup", { session_id: events[0].session_id, message: "more" }))).text();
  const [q, f] = t.audit.entries;
  assert.equal(q.action, "query");
  assert.equal(f.action, "followup");
  assert.equal(q.outcome, "ok");
  assert.deepEqual(q.actor, { id: "user-1", email: "ada@acme.io", role: "tenant-admin", company: "acme" });
  assert.deepEqual(q.servers, [{ id: "srv-pikachu", hostname: "pikachu" }]);
  assert.deepEqual(q.scope.sources, ["decoy_events", "tamper_history", "forensic_findings"]);
  assert.equal(q.session_id, events[0].session_id);
  const dump = JSON.stringify(t.audit.entries);
  assert.ok(!dump.includes(TOKEN) && !dump.includes("letmein99") && !dump.includes(GEMINI_KEY));
});

test("empty result sets still answer (the model is told there is no data)", async () => {
  const routes = defaultRoutes();
  routes["/api/v1/decoys/"] = [];
  routes["/api/v1/dashboard/alerts"] = { data: [], next_cursor: null, has_more: false };
  const t = setup({ routes });
  const events = await readSse(await t.handlers.query(req("query", body())));
  assert.equal(events[0].data_used.record_count, 0);
  assert.match(t.llm.calls[0].messages[0].content, /no records/i);
  assert.equal(events.at(-1).type, "done");
});
