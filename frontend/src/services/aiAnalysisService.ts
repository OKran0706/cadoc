import { parseSseChunk } from "@/lib/sse";
import { getToken, logout } from "@/services/authService";
import type { SseEvent } from "@/lib/ai/types";

export class AiRequestError extends Error {
  code: string;
  status: number;
  retryAfter?: number;
  /** For 403s: "role" (your token's role is not an admin role) or "backend" (the platform refused the admin check). */
  reason?: string;
  constructor(code: string, message: string, status = 0, retryAfter?: number, reason?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.reason = reason;
  }
}

function expireSession(): never {
  logout();
  // Full navigation on purpose (same as lib/api.ts): it discards all in-memory conversation state.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  if (typeof window !== "undefined") window.location.href = "/login";
  throw new AiRequestError("unauthenticated", "Your session has expired. Redirecting to sign in…", 401);
}

/**
 * POST to an AI analysis endpoint and deliver its Server-Sent Events one by one.
 * (EventSource cannot POST, and the token must stay in the Authorization header, never the URL.)
 * Resolves after a terminal `done`/`error` event; rejects with AiRequestError for HTTP-level failures.
 */
export async function streamAnalysis(
  kind: "query" | "followup",
  body: unknown,
  opts: { signal?: AbortSignal; onEvent: (e: SseEvent) => void }
): Promise<void> {
  const token = getToken();
  if (!token) expireSession();

  let res: Response;
  try {
    res = await fetch(`/api/ai-analysis/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: opts.signal,
      cache: "no-store",
    });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    throw new AiRequestError("network", "Could not reach the server. Check your connection and try again.");
  }

  // The route guard redirects cookie-less requests to /login (fetch follows it and lands on HTML).
  if (res.status === 401 || (res.redirected && new URL(res.url).pathname === "/login")) expireSession();

  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as Record<string, unknown>);
    const retry = Number(res.headers.get("retry-after"));
    throw new AiRequestError(
      typeof data.code === "string" ? data.code : "internal_error",
      typeof data.message === "string" ? data.message : "The analysis request failed.",
      res.status,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
      typeof data.reason === "string" ? data.reason : undefined
    );
  }
  if (!res.body) throw new AiRequestError("provider_bad_response", "The server returned an empty response.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  const handle = (raw: string) => {
    let ev: SseEvent;
    try {
      ev = JSON.parse(raw) as SseEvent;
    } catch {
      return;
    }
    if (!ev || typeof ev.type !== "string") return;
    if (ev.type === "done" || ev.type === "error") terminal = true;
    opts.onEvent(ev);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      const { data, rest } = parseSseChunk(done ? `${buffer}\n\n` : buffer);
      buffer = rest;
      data.forEach(handle);
      if (done) break;
    }
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    if (!terminal) throw new AiRequestError("network", "The connection was lost before the analysis finished.");
  }
  if (!terminal) throw new AiRequestError("network", "The connection was interrupted before the analysis finished.");
}
