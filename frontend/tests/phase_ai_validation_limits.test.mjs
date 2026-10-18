import test from "node:test";
import assert from "node:assert/strict";
import { parseQueryRequest, parseFollowupRequest } from "../src/lib/ai/schema.ts";
import { createSessionStore } from "../src/lib/ai/sessions.ts";
import { createRateLimiter, createConcurrencyGate } from "../src/lib/ai/rateLimit.ts";
import { loadAiConfig } from "../src/lib/ai/config.ts";
import { createAuditLog } from "../src/lib/ai/audit.ts";
import { NOW, iso } from "./helpers/ai-fakes.mjs";

const good = () => ({
  servers: ["srv-pikachu"],
  range: { from: iso(120), to: iso(0) },
  sources: ["decoy_events", "forensic_findings"],
  filters: { decoy_type: "ssh_key", status: "tampered" },
  message: "What happened on pikachu in the last 2 hours?",
});

// ── INV-AI-8 ────────────────────────────────────────────────────────────────
test("INV-AI-8: a well-formed query request parses", () => {
  const r = parseQueryRequest(good(), NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.servers, ["srv-pikachu"]);
});

test("INV-AI-8: unknown / privileged client fields are rejected (mass assignment)", () => {
  for (const extra of [{ role: "platform_owner" }, { company_slug: "other" }, { is_admin: true }, { owner_id: "x" }, { status: "x" }]) {
    const r = parseQueryRequest({ ...good(), ...extra }, NOW);
    assert.equal(r.ok, false, `accepted ${Object.keys(extra)}`);
  }
  assert.equal(parseQueryRequest({ ...good(), filters: { status: "tampered", evil: 1 } }, NOW).ok, false);
});

test("INV-AI-8: bounds on servers, sources, message, enums and ids", () => {
  const bad = [
    { servers: [] },
    { servers: Array.from({ length: 11 }, (_, i) => `s${i}`) },
    { servers: ["has space"] },
    { servers: [42] },
    { servers: "srv-pikachu" },
    { sources: [] },
    { sources: ["decoy_events", "shell"] },
    { message: "" },
    { message: "   " },
    { message: "x".repeat(2001) },
    { message: 5 },
    { filters: { status: "owned" } },
    { filters: { decoy_type: "bad type!" } },
  ];
  for (const patch of bad) assert.equal(parseQueryRequest({ ...good(), ...patch }, NOW).ok, false, JSON.stringify(patch).slice(0, 60));
  assert.equal(parseQueryRequest(null, NOW).ok, false);
  assert.equal(parseQueryRequest("str", NOW).ok, false);
  assert.equal(parseQueryRequest([], NOW).ok, false);
});

test("INV-AI-8: time range must be ordered, <= 30 days, and not in the future", () => {
  const r = (from, to) => parseQueryRequest({ ...good(), range: { from, to } }, NOW).ok;
  assert.equal(r(iso(0), iso(60)), false, "from after to");
  assert.equal(r(iso(60), iso(60)), false, "empty range");
  assert.equal(r(iso(31 * 24 * 60), iso(0)), false, "> 30 days");
  assert.equal(r(iso(30 * 24 * 60), iso(0)), true, "exactly 30 days");
  assert.equal(r(iso(10), new Date(NOW + 3600_000).toISOString()), false, "future end");
  assert.equal(r("yesterday", "today"), false, "non-ISO");
  assert.equal(r("2026-10-18", iso(0)), false, "date-only is ambiguous");
});

test("INV-AI-8: duplicate servers are de-duplicated, whitespace trimmed", () => {
  const r = parseQueryRequest({ ...good(), servers: ["srv-a", "srv-a", "srv-b"], message: "  hi  " }, NOW);
  assert.deepEqual(r.value.servers, ["srv-a", "srv-b"]);
  assert.equal(r.value.message, "hi");
});

test("INV-AI-8: follow-up request validation", () => {
  assert.equal(parseFollowupRequest({ session_id: "3f2c1d0e-aaaa-bbbb-cccc-123456789abc", message: "and then?" }).ok, true);
  assert.equal(parseFollowupRequest({ session_id: "../etc", message: "x" }).ok, false);
  assert.equal(parseFollowupRequest({ session_id: "abc", message: "" }).ok, false);
  assert.equal(parseFollowupRequest({ session_id: "abc", message: "x", servers: ["other"] }).ok, false, "scope cannot change mid-session");
});

// ── INV-AI-3 ────────────────────────────────────────────────────────────────
const scope = () => ({ servers: [{ id: "srv-pikachu", hostname: "pikachu" }], range: good().range, sources: ["decoy_events"], filters: {} });

test("INV-AI-3: only the owner can read or append to a session; others see 'not found'", () => {
  const store = createSessionStore({ now: () => NOW });
  const s = store.create("user-a", scope());
  assert.ok(store.get("user-a", s.id));
  assert.equal(store.get("user-b", s.id), null);
  assert.equal(store.append("user-b", s.id, { role: "user", content: "hijack" }), false);
  assert.equal(store.get("user-a", s.id).messages.length, 0);
  assert.equal(store.get("user-a", "does-not-exist"), null);
});

test("INV-AI-3: session ids are unguessable and unique", () => {
  const store = createSessionStore({ now: () => NOW });
  const ids = new Set(Array.from({ length: 50 }, () => store.create("u", scope()).id));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
});

test("INV-AI-3: sessions expire after the TTL and are bounded per user", () => {
  let t = NOW;
  const store = createSessionStore({ now: () => t, ttlMs: 1000, maxPerUser: 2 });
  const a = store.create("u", scope());
  t += 1001;
  assert.equal(store.get("u", a.id), null, "expired");
  const b = store.create("u", scope());
  const c = store.create("u", scope());
  const d = store.create("u", scope());
  assert.equal(store.get("u", b.id), null, "oldest evicted at maxPerUser");
  assert.ok(store.get("u", c.id) && store.get("u", d.id));
});

test("INV-AI-3: history is capped but always keeps the first (data-bearing) message", () => {
  const store = createSessionStore({ now: () => NOW, maxMessages: 6, maxChars: 400 });
  const s = store.create("u", scope());
  store.append("u", s.id, { role: "user", content: "DATA-FIRST" });
  for (let i = 0; i < 10; i++) {
    store.append("u", s.id, { role: "assistant", content: `a${i} ` + "x".repeat(50) });
    store.append("u", s.id, { role: "user", content: `q${i}` });
  }
  const msgs = store.get("u", s.id).messages;
  assert.equal(msgs[0].content, "DATA-FIRST");
  assert.ok(msgs.length <= 6);
  assert.equal(msgs[msgs.length - 1].content, "q9", "newest retained");
  assert.equal(msgs[1].role, "assistant", "roles still alternate after trimming");
});

// ── INV-AI-7 ────────────────────────────────────────────────────────────────
test("INV-AI-7: sliding-window rate limiter is per key and reports Retry-After", () => {
  let t = NOW;
  const rl = createRateLimiter({ max: 3, windowMs: 60_000, now: () => t });
  assert.equal(rl.check("a").ok, true);
  assert.equal(rl.check("a").ok, true);
  assert.equal(rl.check("a").ok, true);
  const blocked = rl.check("a");
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
  assert.equal(rl.check("b").ok, true, "other users unaffected");
  t += 60_001;
  assert.equal(rl.check("a").ok, true, "window slides");
});

test("INV-AI-7: concurrency gate caps simultaneous streams and releases exactly once", () => {
  const gate = createConcurrencyGate({ max: 2 });
  const r1 = gate.acquire("u");
  const r2 = gate.acquire("u");
  assert.ok(r1 && r2);
  assert.equal(gate.acquire("u"), null);
  assert.ok(gate.acquire("other"));
  r1();
  r1(); // double release must not free a second slot
  assert.ok(gate.acquire("u"));
  assert.equal(gate.acquire("u"), null);
});

// ── INV-AI-11 ───────────────────────────────────────────────────────────────
test("INV-AI-11: Gemini config comes from env, with defaults and clamping", () => {
  const r = loadAiConfig({ AI_API_KEY: "AIza-123", BACKEND_URL: "https://api.example.test" });
  assert.equal(r.ok, true);
  assert.equal(r.config.provider, "gemini");
  assert.equal(r.config.model, "gemini-2.5-flash");
  assert.equal(r.config.apiKey, "AIza-123");
  assert.equal(r.config.timeoutMs, 60000);
  assert.equal(r.config.maxRetries, 2);
  assert.equal(r.config.tokenBudget, 24000);
  const c = loadAiConfig({ AI_API_KEY: "k", AI_TIMEOUT_MS: "99999999", AI_MAX_RETRIES: "-4", AI_CONTEXT_TOKEN_BUDGET: "5" }).config;
  assert.equal(c.timeoutMs, 300000);
  assert.equal(c.maxRetries, 0);
  assert.equal(c.tokenBudget, 2000);
  assert.equal(loadAiConfig({ AI_API_KEY: "k", AI_MODEL: "gemini-2.5-pro" }).config.model, "gemini-2.5-pro");
});

test("INV-AI-11: key may come from GEMINI_API_KEY / GOOGLE_API_KEY; AI_API_KEY wins", () => {
  assert.equal(loadAiConfig({ GEMINI_API_KEY: "g" }).config.apiKey, "g");
  assert.equal(loadAiConfig({ GOOGLE_API_KEY: "go" }).config.apiKey, "go");
  assert.equal(loadAiConfig({ AI_API_KEY: "a", GEMINI_API_KEY: "g" }).config.apiKey, "a");
});

test("INV-AI-11: missing key / bad provider / model / base url => ai_not_configured, never leaking secrets", () => {
  const none = loadAiConfig({});
  assert.deepEqual([none.ok, none.code], [false, "ai_not_configured"]);
  const badProvider = loadAiConfig({ AI_API_KEY: "super-secret", AI_PROVIDER: "skynet" });
  assert.equal(badProvider.ok, false);
  assert.ok(!JSON.stringify(badProvider).includes("super-secret"));
  assert.equal(loadAiConfig({ AI_API_KEY: "k", AI_PROVIDER: "gemini" }).ok, true);
  assert.equal(loadAiConfig({ AI_API_KEY: "k", AI_MODEL: "bad/model?x" }).ok, false, "model must be a plain identifier");
  assert.equal(loadAiConfig({ AI_API_KEY: "k", AI_BASE_URL: "javascript:alert(1)" }).ok, false, "base url must be http(s)");
  assert.equal(loadAiConfig({ AI_API_KEY: "k", AI_BASE_URL: "http://evil.test" }).ok, false, "plain http only for localhost");
  assert.equal(loadAiConfig({ AI_API_KEY: "k", AI_BASE_URL: "http://localhost:8080" }).ok, true);
});

// ── INV-AI-10 ───────────────────────────────────────────────────────────────
test("INV-AI-10: audit records carry actor, servers, scope and timestamp, and are bounded", () => {
  const lines = [];
  const audit = createAuditLog({ now: () => NOW, sink: (l) => lines.push(l), maxEntries: 3 });
  for (let i = 0; i < 5; i++) {
    audit.record({
      action: "query",
      actor: { id: "u1", email: "a@x.io", role: "tenant-admin", company: "acme" },
      servers: [{ id: "srv-pikachu", hostname: "pikachu" }],
      scope: { range: good().range, sources: ["decoy_events"], filters: {} },
      session_id: `s${i}`,
      outcome: "ok",
      question: "password=hunter2 what happened?",
    });
  }
  assert.equal(audit.entries.length, 3);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^AUDIT /);
  const rec = JSON.parse(lines[0].slice(6));
  assert.equal(rec.ts, new Date(NOW).toISOString());
  assert.equal(rec.actor.email, "a@x.io");
  assert.ok(!lines[0].includes("hunter2"), "question text is redacted in audit trail");
});
