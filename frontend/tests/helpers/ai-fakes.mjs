// Shared fakes for the AI Logs & Analysis tests.

export const NOW = Date.parse("2026-10-18T12:00:00Z");
export const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

export const SERVERS = [
  { id: "srv-pikachu", project_id: "p1", hostname: "pikachu", ip_address: "10.0.0.1", status: "active", specs: {}, created_at: iso(9999), updated_at: iso(9999) },
  { id: "srv-eevee", project_id: "p1", hostname: "eevee", ip_address: "10.0.0.2", status: "active", specs: {}, created_at: iso(9999), updated_at: iso(9999) },
];

export function decoy(over = {}) {
  return {
    id: "dcy-1",
    server_id: "srv-pikachu",
    file_path: "/home/ash/.ssh/id_rsa",
    decoy_type: "ssh_key",
    original_hash: "a".repeat(64),
    status: "planted",
    planted_at: iso(600),
    last_verified: iso(30),
    created_at: iso(600),
    updated_at: iso(30),
    ...over,
  };
}

export function alert(over = {}) {
  return {
    id: "alt-1",
    server_id: "srv-pikachu",
    event_type: "decoy_tamper",
    severity: "high",
    details: { path: "/home/ash/.ssh/id_rsa" },
    detected_at: iso(20),
    ...over,
  };
}

/**
 * Fake read-only backend. `routes` maps a path to a value or a function(params).
 * Records every call so tests can assert that only GETs were made.
 */
export function makeBackend(routes = {}) {
  const calls = [];
  return {
    calls,
    async get(path, params = {}) {
      calls.push({ method: "GET", path, params });
      const r = routes[path];
      if (r === undefined) {
        const err = new Error("not found");
        err.status = 404;
        throw err;
      }
      if (r instanceof Error) throw r;
      return typeof r === "function" ? r(params) : r;
    },
  };
}

export function httpError(status) {
  const e = new Error(`HTTP ${status}`);
  e.status = status;
  return e;
}

export const defaultRoutes = () => ({
  "/api/v1/servers/": SERVERS,
  "/api/v1/admins/audit-logs": [],
  "/api/v1/decoys/": [decoy()],
  "/api/v1/dashboard/alerts": { data: [alert()], next_cursor: null, has_more: false },
});

// ── SSE helpers (Gemini streamGenerateContent?alt=sse) ──────────────────────
export function sseResponse(events, { status = 200, headers = {} } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const e of events) {
        c.enqueue(enc.encode(`data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`));
      }
      c.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream", ...headers } });
}

const chunk = (parts, finishReason) => ({
  data: { candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }] },
});

export const geminiText = (...texts) => [
  ...texts.map((t) => chunk([{ text: t }])),
  { data: { candidates: [{ finishReason: "STOP" }], usageMetadata: { totalTokenCount: 10 } } },
];

export const geminiToolCall = (name, args, extra = {}) => [chunk([{ functionCall: { name, args }, ...extra }], "STOP")];

export async function collect(iterable) {
  const out = [];
  for await (const x of iterable) out.push(x);
  return out;
}

export async function readSse(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data:"))
    .map((b) => JSON.parse(b.replace(/^data:\s*/, "")));
}
