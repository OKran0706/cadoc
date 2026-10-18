import test from "node:test";
import assert from "node:assert/strict";
import { streamLlm, AiProviderError } from "../src/lib/ai/provider.ts";
import { sseResponse, geminiText, geminiToolCall, collect } from "./helpers/ai-fakes.mjs";

const KEY = "AIzaSy-TESTKEY-0123456789";
const cfg = (over = {}) => ({
  provider: "gemini",
  model: "gemini-2.5-flash",
  apiKey: KEY,
  baseUrl: "",
  timeoutMs: 2000,
  maxRetries: 2,
  maxOutputTokens: 1024,
  ...over,
});
const params = (over = {}) => ({
  config: cfg(),
  system: "SYS",
  messages: [{ role: "user", content: "hello" }],
  tools: [{ name: "get_logs", description: "d", input_schema: { type: "object", properties: { server: { type: "string" } } } }],
  ...over,
});
const noSleep = { sleep: async () => {} };

async function failure(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  assert.fail("expected rejection");
}

test("gemini: streams text deltas and a stop reason; request shape is correct and the key stays out of the URL", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return sseResponse(geminiText("Hel", "lo"));
  };
  const events = await collect(streamLlm(params(), { fetchImpl, ...noSleep }));
  assert.deepEqual(events.filter((e) => e.type === "text").map((e) => e.text), ["Hel", "lo"]);
  assert.deepEqual(events.at(-1), { type: "stop", reason: "end_turn" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
  assert.ok(!seen[0].url.includes(KEY), "api key must travel in a header, not the URL");
  assert.equal(seen[0].init.headers["x-goog-api-key"], KEY);
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.systemInstruction.parts[0].text, "SYS");
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "hello" }] }]);
  assert.equal(body.generationConfig.maxOutputTokens, 1024);
  assert.equal(body.tools[0].functionDeclarations[0].name, "get_logs");
});

test("gemini: the model name is URL-encoded and validated (no path injection)", async () => {
  const e = await failure(collect(streamLlm(params({ config: cfg({ model: "x/../../evil?key=1" }) }), { fetchImpl: async () => sseResponse(geminiText("a")), ...noSleep })));
  assert.equal(e.code, "provider_rejected");
});

test("gemini: omits tools entirely when none are offered", async () => {
  let body;
  await collect(streamLlm(params({ tools: [] }), { fetchImpl: async (u, i) => ((body = JSON.parse(i.body)), sseResponse(geminiText("a"))), ...noSleep }));
  assert.equal(body.tools, undefined);
});

test("gemini: function calls become tool_use events with generated ids and stop reason tool_use", async () => {
  const args = { server: "pikachu", from: "2026-10-18T10:00:00Z", to: "2026-10-18T11:00:00Z", source: "decoy_events" };
  const fetchImpl = async () => sseResponse(geminiToolCall("get_logs", args, { thoughtSignature: "sig-abc" }));
  const events = await collect(streamLlm(params(), { fetchImpl, ...noSleep }));
  const tool = events.find((e) => e.type === "tool_use");
  assert.equal(tool.name, "get_logs");
  assert.deepEqual(tool.input, args);
  assert.ok(typeof tool.id === "string" && tool.id.length > 0);
  assert.equal(tool.signature, "sig-abc", "thought signature is surfaced so it can be echoed back");
  assert.deepEqual(events.at(-1), { type: "stop", reason: "tool_use" });
});

test("gemini: tool_use / tool_result history maps to functionCall / functionResponse (by name, signature echoed)", async () => {
  let body;
  const fetchImpl = async (u, i) => ((body = JSON.parse(i.body)), sseResponse(geminiText("done")));
  await collect(
    streamLlm(
      params({
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "call_0", name: "get_logs", input: { server: "x" }, signature: "sig-1" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_0", content: "DATA" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_logs", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "bad input", is_error: true }] },
        ],
      }),
      { fetchImpl, ...noSleep }
    )
  );
  const [, a1, u1, , u2] = body.contents;
  assert.equal(a1.role, "model");
  assert.deepEqual(a1.parts[1].functionCall, { name: "get_logs", args: { server: "x" } });
  assert.equal(a1.parts[1].thoughtSignature, "sig-1");
  assert.equal(u1.role, "user");
  assert.deepEqual(u1.parts[0].functionResponse, { name: "get_logs", response: { content: "DATA" } });
  assert.deepEqual(u2.parts[0].functionResponse, { name: "get_logs", response: { error: "bad input" } });
});

test("retries 429 and 5xx with capped backoff, then succeeds", async () => {
  let n = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    n++;
    if (n === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
    if (n === 2) return new Response("boom", { status: 503 });
    return sseResponse(geminiText("ok"));
  };
  const events = await collect(streamLlm(params(), { fetchImpl, sleep: async (ms) => void sleeps.push(ms) }));
  assert.equal(n, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms <= 5000));
  assert.equal(events.find((e) => e.type === "text").text, "ok");
});

test("gives up after maxRetries with a safe classified error (no upstream body or key in the message)", async () => {
  let n = 0;
  const fetchImpl = async () => (n++, new Response(`{"error":"internal host ec2-3-89-18-5 key ${KEY}"}`, { status: 502 }));
  const e = await failure(collect(streamLlm(params(), { fetchImpl, ...noSleep })));
  assert.ok(e instanceof AiProviderError);
  assert.equal(e.code, "provider_unavailable");
  assert.equal(n, 3);
  assert.ok(!e.message.includes("ec2-") && !e.message.includes("AIza"));
});

test("bad API key (Gemini answers 400 API_KEY_INVALID, or 401/403) => provider_auth, not retried", async () => {
  for (const [status, text] of [
    [400, `{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","details":[{"reason":"API_KEY_INVALID"}]}}`],
    [401, "unauthenticated"],
    [403, "PERMISSION_DENIED"],
  ]) {
    let n = 0;
    const e = await failure(collect(streamLlm(params(), { fetchImpl: async () => (n++, new Response(text, { status })), ...noSleep })));
    assert.equal(e.code, "provider_auth", `status ${status}`);
    assert.equal(n, 1);
    assert.ok(!e.message.includes("AIza"));
  }
});

test("rate-limit exhaustion => provider_rate_limited; other 400 => provider_rejected", async () => {
  const e1 = await failure(collect(streamLlm(params({ config: cfg({ maxRetries: 1 }) }), { fetchImpl: async () => new Response("", { status: 429, headers: { "retry-after": "0" } }), ...noSleep })));
  assert.equal(e1.code, "provider_rate_limited");
  const e2 = await failure(collect(streamLlm(params(), { fetchImpl: async () => new Response("input token count exceeds the maximum", { status: 400 }), ...noSleep })));
  assert.equal(e2.code, "provider_rejected");
});

test("safety-blocked answers => provider_blocked (prompt block or SAFETY finish reason)", async () => {
  const blockedPrompt = async () => sseResponse([{ data: { promptFeedback: { blockReason: "SAFETY" } } }]);
  assert.equal((await failure(collect(streamLlm(params(), { fetchImpl: blockedPrompt, ...noSleep })))).code, "provider_blocked");
  const blockedOut = async () => sseResponse([{ data: { candidates: [{ finishReason: "SAFETY" }] } }]);
  assert.equal((await failure(collect(streamLlm(params(), { fetchImpl: blockedOut, ...noSleep })))).code, "provider_blocked");
});

test("MAX_TOKENS finish is reported as stop reason max_tokens (answer was cut off)", async () => {
  const fetchImpl = async () => sseResponse([{ data: { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }] } }]);
  const events = await collect(streamLlm(params(), { fetchImpl, ...noSleep }));
  assert.deepEqual(events.at(-1), { type: "stop", reason: "max_tokens" });
});

test("times out when the provider never answers", async () => {
  const fetchImpl = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted"))));
  const started = Date.now();
  const e = await failure(collect(streamLlm(params({ config: cfg({ timeoutMs: 40, maxRetries: 0 }) }), { fetchImpl, ...noSleep })));
  assert.equal(e.code, "provider_timeout");
  assert.ok(Date.now() - started < 1500);
});

test("times out when the stream goes idle mid-answer; text before the stall is delivered", async () => {
  const enc = new TextEncoder();
  const fetchImpl = async (url, init) => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })}\n\n`));
        init.signal.addEventListener("abort", () => c.error(init.signal.reason ?? new Error("aborted")));
      },
    });
    return new Response(body, { status: 200 });
  };
  const got = [];
  const e = await failure(
    (async () => {
      for await (const ev of streamLlm(params({ config: cfg({ timeoutMs: 50, maxRetries: 2 }) }), { fetchImpl, ...noSleep })) got.push(ev);
    })()
  );
  assert.equal(e.code, "provider_timeout");
  assert.equal(got[0].text, "partial");
});

test("never retries once output has started (no duplicated text)", async () => {
  let n = 0;
  const enc = new TextEncoder();
  const fetchImpl = async () => {
    n++;
    let pulls = 0;
    const body = new ReadableStream({
      pull(c) {
        // error() on the same tick as enqueue() would discard the chunk, so fail on the *next* pull
        if (pulls++ === 0) c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }] })}\n\n`));
        else c.error(new Error("socket hang up"));
      },
    });
    return new Response(body, { status: 200 });
  };
  const e = await failure(collect(streamLlm(params(), { fetchImpl, ...noSleep })));
  assert.equal(n, 1);
  assert.equal(e.code, "provider_unavailable");
});

test("caller abort stops the stream with code 'aborted' and does not retry", async () => {
  const ac = new AbortController();
  let n = 0;
  const fetchImpl = (url, init) =>
    new Promise((_, reject) => {
      n++;
      init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
      queueMicrotask(() => ac.abort());
    });
  const e = await failure(collect(streamLlm(params({ signal: ac.signal }), { fetchImpl, ...noSleep })));
  assert.equal(e.code, "aborted");
  assert.equal(n, 1);
});

test("an unsupported provider value is refused (Gemini is the only implemented provider)", async () => {
  const e = await failure(collect(streamLlm(params({ config: cfg({ provider: "anthropic" }) }), { fetchImpl: async () => sseResponse(geminiText("a")), ...noSleep })));
  assert.equal(e.code, "ai_not_configured");
});
