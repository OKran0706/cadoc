// HTTP-level orchestration for POST /api/ai-analysis/query and /followup. Standard Request/Response in,
// all dependencies injected, so every invariant is testable without Next.
//
// Order is deliberate: authorize -> config -> rate limit -> concurrency -> body -> validate -> scope -> data -> LLM.

import { runTurn } from "./analysis.ts";
import type { AuditActor, AuditLog } from "./audit.ts";
import { collectData, resolveServers } from "./collect.ts";
import type { ConfigResult } from "./config.ts";
import { buildContext } from "./context.ts";
import { AiHttpError, AiProviderError, mapBackendError, safeMessage } from "./errors.ts";
import { authorizeAdmin } from "./guard.ts";
import type { Identity } from "./guard.ts";
import { buildFirstUserMessage } from "./prompt.ts";
import type { ConcurrencyGate, RateLimiter } from "./rateLimit.ts";
import { redactText } from "./redact.ts";
import { parseFollowupRequest, parseQueryRequest } from "./schema.ts";
import type { Session, SessionStore } from "./sessions.ts";
import type { AiConfig, Backend, LlmEvent, LlmMessage, LlmParams, SseEvent } from "./types.ts";

const MAX_BODY_CHARS = 32 * 1024;
const DEFAULT_PROBE = "/api/v1/admins/audit-logs";

export interface HandlerDeps {
  loadConfig: () => ConfigResult;
  createBackend: (token: string) => Backend;
  llm: (p: LlmParams) => AsyncIterable<LlmEvent>;
  sessions: SessionStore;
  limiter: RateLimiter;
  gate: ConcurrencyGate;
  audit: AuditLog;
  now: () => number;
  adminProbePath?: string;
  log?: (msg: string) => void;
}

export interface Handlers {
  query(req: Request): Promise<Response>;
  followup(req: Request): Promise<Response>;
}

type Kind = "query" | "followup";

function actorOf(i?: Partial<Identity>): AuditActor {
  if (!i?.id) return { id: "anonymous" };
  const a: AuditActor = { id: i.id };
  if (i.email) a.email = i.email;
  if (i.role) a.role = i.role;
  if (i.company) a.company = i.company;
  return a;
}

export function createHandlers(deps: HandlerDeps): Handlers {
  const log = deps.log ?? (() => {});
  const probePath = deps.adminProbePath ?? DEFAULT_PROBE;

  /** Operator-facing line explaining a refusal/outage (cause codes and paths only; redacted; never sent to the client). */
  const explain = (he: AiHttpError, who?: string) =>
    log(`[ai-analysis] ${he.code} actor=${who ?? "anonymous"}${he.reason ? ` reason=${redactText(he.reason).text.slice(0, 300)}` : ""}`);

  const json = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ code, message: safeMessage(code), ...extra }), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
    });

  async function handle(kind: Kind, req: Request): Promise<Response> {
    // 1. who is calling (INV-AI-1)
    let identity: Identity;
    try {
      identity = await authorizeAdmin({ headers: req.headers, createBackend: deps.createBackend, probePath, now: deps.now });
    } catch (e) {
      const he = e instanceof AiHttpError ? e : mapBackendError(e);
      const who = (e as { identity?: Identity }).identity;
      deps.audit.record({ action: "denied", actor: actorOf(who), outcome: he.code });
      explain(he, who?.id);
      // `reason` is a coarse, non-sensitive hint for the UI; the precise explanation stays in the server log
      return json(he.status, he.code, he.status === 403 ? { reason: he.reason?.startsWith("token role") ? "role" : "backend" } : {});
    }
    const actor = actorOf(identity);
    const rejected = (status: number, code: string, extra: Partial<Parameters<AuditLog["record"]>[0]> = {}, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
      deps.audit.record({ action: kind, actor, outcome: code, ...extra });
      return json(status, code, body, headers);
    };

    // 2. is the feature configured (never disclosed to unauthenticated callers)
    const cfg = deps.loadConfig();
    if (!cfg.ok) return rejected(503, cfg.code);
    const config: AiConfig = cfg.config;

    // 3. abuse controls (INV-AI-7)
    const rl = deps.limiter.check(identity.id);
    if (!rl.ok) return rejected(429, "rate_limited", {}, { retry_after: rl.retryAfterSec }, { "retry-after": String(rl.retryAfterSec) });
    const release = deps.gate.acquire(identity.id);
    if (!release) return rejected(429, "too_many_concurrent");

    let handedOff = false;
    try {
      // 4. body (INV-AI-8)
      const declared = Number(req.headers.get("content-length") ?? 0);
      if (declared > MAX_BODY_CHARS) return rejected(413, "payload_too_large");
      const raw = await req.text();
      if (raw.length > MAX_BODY_CHARS) return rejected(413, "payload_too_large");
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return rejected(400, "invalid_request");
      }

      const backend = deps.createBackend(identity.token);
      let session: Session;
      let userMessage: LlmMessage;
      let question: string;
      let isNew = false;

      if (kind === "query") {
        const parsed = parseQueryRequest(body, deps.now());
        if (!parsed.ok) return rejected(400, "invalid_request", {}, { field: parsed.field });
        const q = parsed.value;
        question = q.message;

        // 5. scope: only the caller's own servers (INV-AI-2)
        let servers;
        let collected;
        try {
          servers = await resolveServers(backend, q.servers);
          collected = await collectData({ backend, servers, range: q.range, sources: q.sources, filters: q.filters });
        } catch (e) {
          const he = e instanceof AiHttpError ? e : mapBackendError(e);
          explain(he, identity.id);
          return rejected(he.status, he.code);
        }
        const auditScope = { servers, scope: { range: q.range, sources: q.sources, filters: q.filters }, question };
        if (q.sources.every((s) => collected.unavailable.some((u) => u.source === s))) {
          log(`[ai-analysis] data_unavailable actor=${identity.id} reason=${collected.unavailable.map((u) => `${u.source}: ${u.reason}`).join("; ")}`);
          return rejected(502, "data_unavailable", auditScope);
        }

        // 6. context (redacted, aggregated, budgeted, delimited)
        const built = buildContext({ records: collected.records, servers, range: q.range, sources: q.sources, unavailable: collected.unavailable, notes: collected.notes, tokenBudget: config.tokenBudget });
        session = deps.sessions.create(identity.id, { servers, range: q.range, sources: q.sources, filters: q.filters });
        isNew = true;
        session.dataUsed = built.dataUsed;
        session.truncation = built.truncation;
        const scopeSummary = `${servers.map((s) => s.hostname).join(", ")}; ${q.range.from} to ${q.range.to}; sources: ${q.sources.join(", ")}`;
        userMessage = {
          role: "user",
          content: buildFirstUserMessage({ question: redactText(question).text, scopeSummary, contextText: built.text }),
        };
      } else {
        const parsed = parseFollowupRequest(body);
        if (!parsed.ok) return rejected(400, "invalid_request", {}, { field: parsed.field });
        const existing = deps.sessions.get(identity.id, parsed.value.session_id);
        if (!existing || existing.messages.length === 0) return rejected(404, "session_not_found");
        session = existing;
        question = parsed.value.message;
        userMessage = { role: "user", content: redactText(question).text };
      }

      // 7. stream the analysis (lazy: nothing runs until the client reads)
      const ac = new AbortController();
      req.signal?.addEventListener("abort", () => ac.abort(), { once: true });
      const sessionRef = session;
      const turnDeps = { llm: deps.llm, backend, config, now: deps.now };

      async function* events(): AsyncGenerator<SseEvent> {
        yield { type: "meta", session_id: sessionRef.id, data_used: sessionRef.dataUsed!, truncation: sessionRef.truncation };
        const out = { text: "" };
        yield* runTurn(turnDeps, { session: sessionRef, userMessage, signal: ac.signal }, out);
        deps.sessions.append(identity.id, sessionRef.id, userMessage);
        deps.sessions.append(identity.id, sessionRef.id, { role: "assistant", content: out.text });
      }

      const gen = events();
      let finished = false;
      const finalize = (outcome: string) => {
        if (finished) return;
        finished = true;
        release();
        deps.audit.record({
          action: kind,
          actor,
          servers: sessionRef.scope.servers,
          scope: { range: sessionRef.scope.range, sources: sessionRef.scope.sources, filters: sessionRef.scope.filters },
          session_id: sessionRef.id,
          outcome,
          question,
        });
      };
      const enc = new TextEncoder();
      const frame = (e: SseEvent) => enc.encode(`data: ${JSON.stringify(e)}\n\n`);

      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const { value, done } = await gen.next();
              if (done) {
                finalize("ok");
                controller.close();
                return;
              }
              controller.enqueue(frame(value));
            } catch (e) {
              const code = e instanceof AiProviderError || e instanceof AiHttpError ? e.code : "internal_error";
              log(`[ai-analysis] ${code}: ${redactText(e instanceof Error ? e.message : "unknown").text.slice(0, 300)}`);
              if (isNew) deps.sessions.delete(identity.id, sessionRef.id);
              controller.enqueue(frame({ type: "error", code, message: safeMessage(code) }));
              finalize(code === "aborted" ? "cancelled" : "error");
              controller.close();
            }
          },
          cancel() {
            ac.abort();
            void gen.return(undefined).catch(() => {});
            if (isNew && !finished) deps.sessions.delete(identity.id, sessionRef.id);
            finalize("cancelled");
          },
        },
        new CountQueuingStrategy({ highWaterMark: 0 })
      );

      handedOff = true;
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      });
    } catch (e) {
      log(`[ai-analysis] unexpected: ${redactText(e instanceof Error ? e.message : "unknown").text.slice(0, 300)}`);
      return rejected(500, "internal_error");
    } finally {
      if (!handedOff) release();
    }
  }

  return {
    query: (req) => handle("query", req),
    followup: (req) => handle("followup", req),
  };
}
