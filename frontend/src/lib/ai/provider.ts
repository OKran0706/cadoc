// Gemini streaming client (generativelanguage.googleapis.com, streamGenerateContent?alt=sse).
//  - API key travels in the x-goog-api-key header, never in the URL
//  - retries (429 / 5xx / network) ONLY before any output was produced, so text is never duplicated
//  - connect+idle timeout per attempt, caller abort honoured, every failure mapped to a safe code
//  - upstream response bodies are inspected for classification but never surfaced

import { randomUUID } from "node:crypto";
import { AiProviderError } from "./errors.ts";
import type { Block, LlmEvent, LlmMessage, LlmParams } from "./types.ts";

export { AiProviderError } from "./errors.ts";

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const BLOCKED_FINISH = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION", "IMAGE_SAFETY"]);
const MAX_BACKOFF_MS = 5000;

export interface LlmDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type Json = Record<string, unknown>;
type Part = Json;

function toContents(messages: LlmMessage[]): Json[] {
  const names = new Map<string, string>();
  const out: Json[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts: Part[] = [];
    if (typeof m.content === "string") {
      if (m.content) parts.push({ text: m.content });
    } else {
      for (const b of m.content as Block[]) {
        if (b.type === "text") {
          if (b.text) parts.push({ text: b.text });
        } else if (b.type === "tool_use") {
          names.set(b.id, b.name);
          parts.push({ functionCall: { name: b.name, args: b.input }, ...(b.signature ? { thoughtSignature: b.signature } : {}) });
        } else {
          parts.push({
            functionResponse: { name: names.get(b.tool_use_id) ?? "get_logs", response: b.is_error ? { error: b.content } : { content: b.content } },
          });
        }
      }
    }
    if (parts.length) out.push({ role, parts });
  }
  return out;
}

function buildBody(p: LlmParams): Json {
  const body: Json = {
    systemInstruction: { parts: [{ text: p.system }] },
    contents: toContents(p.messages),
    generationConfig: { maxOutputTokens: p.config.maxOutputTokens, temperature: 0.2 },
  };
  if (p.tools.length) {
    body.tools = [{ functionDeclarations: p.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) }];
  }
  return body;
}

function classifyStatus(status: number, text: string): { error: AiProviderError; retryable: boolean } {
  if (status === 401 || status === 403) return { error: new AiProviderError("provider_auth"), retryable: false };
  if (status === 400 && /API_KEY_INVALID|API key not valid|API key expired/i.test(text)) {
    return { error: new AiProviderError("provider_auth"), retryable: false };
  }
  if (status === 429) return { error: new AiProviderError("provider_rate_limited"), retryable: true };
  if (RETRYABLE.has(status) || status >= 500) return { error: new AiProviderError("provider_unavailable"), retryable: true };
  return { error: new AiProviderError("provider_rejected"), retryable: false };
}

function retryDelay(attempt: number, retryAfter: string | null): number {
  const secs = Number(retryAfter);
  if (retryAfter !== null && Number.isFinite(secs) && secs >= 0) return Math.min(MAX_BACKOFF_MS, secs * 1000);
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt + Math.floor(Math.random() * 250));
}

interface StreamState {
  finish?: string;
  sawTool: boolean;
  any: boolean;
}

function* handleBlock(block: string, st: StreamState): Generator<LlmEvent> {
  const data = block
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("\n");
  if (!data || data === "[DONE]") return;
  let chunk: Json;
  try {
    chunk = JSON.parse(data) as Json;
  } catch {
    throw new AiProviderError("provider_bad_response");
  }
  if (chunk.error) throw new AiProviderError("provider_unavailable");
  const fb = chunk.promptFeedback as Json | undefined;
  if (fb?.blockReason) throw new AiProviderError("provider_blocked");
  const cand = (chunk.candidates as Json[] | undefined)?.[0];
  if (!cand) return;
  const parts = ((cand.content as Json | undefined)?.parts as Part[] | undefined) ?? [];
  for (const part of parts) {
    if (part.thought === true) continue; // thought summaries are not part of the answer
    if (typeof part.text === "string" && part.text) {
      st.any = true;
      yield { type: "text", text: part.text };
    } else if (part.functionCall && typeof part.functionCall === "object") {
      const fc = part.functionCall as Json;
      st.any = true;
      st.sawTool = true;
      yield {
        type: "tool_use",
        id: typeof fc.id === "string" && fc.id ? fc.id : `call_${randomUUID().slice(0, 8)}`,
        name: String(fc.name ?? ""),
        input: fc.args && typeof fc.args === "object" ? (fc.args as Record<string, unknown>) : {},
        ...(typeof part.thoughtSignature === "string" ? { signature: part.thoughtSignature } : {}),
      };
    }
  }
  if (typeof cand.finishReason === "string") st.finish = cand.finishReason;
}

export async function* streamLlm(p: LlmParams, deps: LlmDeps = {}): AsyncGenerator<LlmEvent> {
  const { config } = p;
  if (config.provider !== "gemini") throw new AiProviderError("ai_not_configured");
  if (!MODEL_RE.test(config.model)) throw new AiProviderError("provider_rejected");

  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = (config.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const url = `${base}/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`;
  const headers = { "content-type": "application/json", "x-goog-api-key": config.apiKey };
  const body = JSON.stringify(buildBody(p));

  for (let attempt = 0; ; attempt++) {
    if (p.signal?.aborted) throw new AiProviderError("aborted");
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    p.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, config.timeoutMs);
    };
    let started = false;

    try {
      arm();
      const res = await fetchImpl(url, { method: "POST", headers, body, signal: ctl.signal });

      if (!res.ok) {
        const text = await res.text().then((t) => t.slice(0, 2000)).catch(() => "");
        const { error, retryable } = classifyStatus(res.status, text);
        if (retryable && attempt < config.maxRetries) {
          clearTimeout(timer);
          await sleep(retryDelay(attempt, res.headers.get("retry-after")));
          continue;
        }
        throw error;
      }
      if (!res.body) throw new AiProviderError("provider_bad_response");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const st: StreamState = { sawTool: false, any: false };
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        arm();
        if (value) buf += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const ev of handleBlock(block, st)) {
            started = true;
            yield ev;
          }
        }
        if (done) break;
      }
      if (buf.trim()) {
        for (const ev of handleBlock(buf, st)) {
          started = true;
          yield ev;
        }
      }
      if (st.finish && BLOCKED_FINISH.has(st.finish)) throw new AiProviderError("provider_blocked");
      if (!st.any && !st.finish) throw new AiProviderError("provider_bad_response");
      yield { type: "stop", reason: st.sawTool ? "tool_use" : st.finish === "MAX_TOKENS" ? "max_tokens" : "end_turn" };
      return;
    } catch (e) {
      if (e instanceof AiProviderError) throw e;
      if (p.signal?.aborted) throw new AiProviderError("aborted");
      if (!started && attempt < config.maxRetries) {
        clearTimeout(timer);
        await sleep(retryDelay(attempt, null));
        continue;
      }
      throw new AiProviderError(timedOut ? "provider_timeout" : "provider_unavailable");
    } finally {
      clearTimeout(timer);
      p.signal?.removeEventListener("abort", onAbort);
    }
  }
}
