// LLM + runtime configuration, from environment variables only (INV-AI-11).
//
//   AI_PROVIDER              gemini (only implemented provider)            default: gemini
//   AI_API_KEY               Gemini API key (or GEMINI_API_KEY / GOOGLE_API_KEY)   required
//   AI_MODEL                 Gemini model id                               default: gemini-2.5-flash
//   AI_BASE_URL              override API root (proxies / tests)           default: Google's v1beta
//   AI_TIMEOUT_MS            connect + idle timeout per attempt            default: 60000  (1s..5m)
//   AI_MAX_RETRIES           retries on 429/5xx/network before any output  default: 2      (0..5)
//   AI_MAX_OUTPUT_TOKENS     answer length cap                             default: 4096
//   AI_CONTEXT_TOKEN_BUDGET  max tokens of log data per request            default: 24000
//   AI_RATE_LIMIT_MAX / AI_RATE_LIMIT_WINDOW_SEC   per-user limit          default: 20 / 600
//   AI_MAX_CONCURRENT        simultaneous streams per user                 default: 2
//   AI_ADMIN_PROBE_PATH      admin-only backend GET used to verify RBAC    default: /api/v1/admins/audit-logs
//   BACKEND_URL              platform API root (falls back to NEXT_PUBLIC_API_URL)

import { safeMessage } from "./errors.ts";
import type { AiConfig } from "./types.ts";

export type ConfigResult = { ok: true; config: AiConfig } | { ok: false; code: "ai_not_configured"; message: string };
type Env = Record<string, string | undefined>;

// Same default the dashboard's /api/v1 proxy route has always used.
const DEFAULT_BACKEND_URL = "https://ec2-3-89-18-5.compute-1.amazonaws.com";
const DEFAULT_MODEL = "gemini-2.5-flash";
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

const fail = (): ConfigResult => ({ ok: false, code: "ai_not_configured", message: safeMessage("ai_not_configured") });

function int(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function validBaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function loadAiConfig(env: Env): ConfigResult {
  const provider = (env.AI_PROVIDER || "gemini").trim().toLowerCase();
  if (provider !== "gemini") return fail();

  const apiKey = (env.AI_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "").trim();
  if (!apiKey) return fail();

  const model = (env.AI_MODEL || DEFAULT_MODEL).trim();
  if (!MODEL_RE.test(model)) return fail();

  const baseUrl = (env.AI_BASE_URL || "").trim().replace(/\/+$/, "");
  if (baseUrl && !validBaseUrl(baseUrl)) return fail();

  return {
    ok: true,
    config: {
      provider: "gemini",
      model,
      apiKey,
      baseUrl,
      timeoutMs: int(env.AI_TIMEOUT_MS, 60_000, 1_000, 300_000),
      maxRetries: int(env.AI_MAX_RETRIES, 2, 0, 5),
      maxOutputTokens: int(env.AI_MAX_OUTPUT_TOKENS, 4096, 256, 16_384),
      tokenBudget: int(env.AI_CONTEXT_TOKEN_BUDGET, 24_000, 2_000, 200_000),
      rateLimitMax: int(env.AI_RATE_LIMIT_MAX, 20, 1, 1_000),
      rateLimitWindowSec: int(env.AI_RATE_LIMIT_WINDOW_SEC, 600, 10, 86_400),
      maxConcurrent: int(env.AI_MAX_CONCURRENT, 2, 1, 10),
    },
  };
}

export function resolveBackendUrl(env: Env): string {
  return (env.BACKEND_URL || env.NEXT_PUBLIC_API_URL || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, "");
}

export function resolveProbePath(env: Env): string {
  const p = (env.AI_ADMIN_PROBE_PATH || "/api/v1/admins/audit-logs").trim();
  return p.startsWith("/api/v1/") && !p.includes("..") && !p.includes("?") ? p : "/api/v1/admins/audit-logs";
}
