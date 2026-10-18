// Production wiring for the AI handlers. Kept on globalThis so sessions, rate limits and the
// audit ring survive Next dev hot-reloads (and are shared by both route files).

import { createAuditLog } from "./audit.ts";
import { createHttpBackend } from "./backend.ts";
import { loadAiConfig, resolveBackendUrl, resolveProbePath } from "./config.ts";
import { createHandlers } from "./handlers.ts";
import type { Handlers } from "./handlers.ts";
import { streamLlm } from "./provider.ts";
import { createConcurrencyGate, createRateLimiter } from "./rateLimit.ts";
import { createSessionStore } from "./sessions.ts";

const g = globalThis as typeof globalThis & { __sentinelAiHandlers?: Handlers };

export function getAiHandlers(): Handlers {
  if (!g.__sentinelAiHandlers) {
    const env = process.env;
    const cfg = loadAiConfig(env);
    const limits = cfg.ok ? cfg.config : { rateLimitMax: 20, rateLimitWindowSec: 600, maxConcurrent: 2 };
    g.__sentinelAiHandlers = createHandlers({
      loadConfig: () => loadAiConfig(process.env),
      // Same opt-in rule the /api/v1 proxy route already uses, but scoped to this client only (see backend.ts).
      createBackend: (token) =>
        createHttpBackend({
          baseUrl: resolveBackendUrl(process.env),
          token,
          allowSelfSigned: process.env.NODE_ENV !== "production" || process.env.ALLOW_SELF_SIGNED_CERTS === "true",
        }),
      llm: (p) => streamLlm(p),
      sessions: createSessionStore(),
      limiter: createRateLimiter({ max: limits.rateLimitMax, windowMs: limits.rateLimitWindowSec * 1000 }),
      gate: createConcurrencyGate({ max: limits.maxConcurrent }),
      audit: createAuditLog(),
      now: Date.now,
      adminProbePath: resolveProbePath(env),
      log: (m) => console.error(m),
    });
  }
  return g.__sentinelAiHandlers;
}
