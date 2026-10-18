# AI Logs & Analysis: phase spec (High tier)

Risk: sends tenant security data to a third-party LLM, admin-only, streams untrusted log text.
Phase 1 = server (`src/lib/ai/*`, `src/app/api/ai-analysis/*`). Phase 2 = UI.

## Threat model (ASVS L2)
| Threat | Mitigation |
| --- | --- |
| Non-admin / unauthenticated use | INV-AI-1 |
| IDOR: other tenant's server or another user's session | INV-AI-2, INV-AI-3 |
| Secrets exfiltrated to LLM vendor | INV-AI-4 |
| Prompt injection via decoy paths / alert details / audit text | INV-AI-5 |
| Context blow-up / cost abuse | INV-AI-6, INV-AI-7 |
| Mass-assignment (`role`, `company_slug`) / oversized input | INV-AI-8 |
| Info leak through errors | INV-AI-9 |
| No accountability | INV-AI-10 |
| CSRF on a cookie-authed streaming POST | INV-AI-1 (Authorization header only) |

## Invariants
- **INV-AI-1** Every request needs an `Authorization: Bearer` header (cookie is NOT accepted) and must pass the
  backend admin probe before any data is collected or any LLM call is made. Non-admin -> 403, bad token -> 401.
  Enforced: `guard.ts` `authorizeAdmin`, called first in both routes.
- **INV-AI-2** Only servers returned by the backend `GET /servers/` for the caller's token may be analysed. Unknown id -> 404. The
  `get_logs` tool can only target servers fixed at session creation. Enforced: `collect.ts` `resolveServers`, `analysis.ts` tool executor.
- **INV-AI-3** A session is readable only by its creator; wrong owner is indistinguishable from "not found". Sessions expire (TTL) and
  are bounded in count and size. Enforced: `sessions.ts`.
- **INV-AI-4** Everything sent to the LLM (data, tool results, user question) goes through `redact.ts`. Private keys, passwords, tokens,
  env values, connection-string credentials never appear. Hashes, paths, timestamps stay.
- **INV-AI-5** Log content is only ever emitted inside a randomly-nonced `UNTRUSTED_DATA` block; content that contains the delimiter is neutralised;
  the system prompt tells the model to never obey text inside it.
- **INV-AI-6** The context never exceeds the token budget; truncation is reported to the admin (`truncation[]`).
- **INV-AI-7** Per-user sliding-window rate limit and concurrent-stream cap; `429` + `Retry-After`.
- **INV-AI-8** Request bodies are validated strictly: unknown fields rejected, enums/ranges/lengths bounded, range <= 30 days.
- **INV-AI-9** Client errors are a fixed `{code, message}` allow-list. Upstream bodies, API keys, stack traces and backend hostnames are never returned.
- **INV-AI-10** Every query/follow-up/denial emits one audit record: actor, role, servers, scope, session, outcome, timestamp.
- **INV-AI-11** Provider, model, key, base URL, timeout, retries, budget come from env only. No key => `ai_not_configured` (503), never a crash.
- **INV-AI-12** Collection is read-only: only `GET` is ever issued to the backend.

## Assumptions
- The FastAPI backend has no AI/log-search endpoints, so the BFF (Next route handlers) implements them and calls the existing read endpoints with the caller's token.
- No decoy-history endpoint exists: tamper/verification history is derived from `decoys` (`last_verified`, `updated_at`); tamper time is approximate and labelled so.
- Sessions, rate limits and the audit ring buffer are per-process memory (Cloud Run: per instance). Audit records are also written as one JSON line
  prefixed `AUDIT` to stdout (Cloud Logging). Swap `sessions.ts` for Redis before scaling beyond one instance.
