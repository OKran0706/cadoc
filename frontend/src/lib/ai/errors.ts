// Fixed allow-list of client-visible errors (INV-AI-9). Nothing from an upstream
// response, exception, stack trace or hostname is ever interpolated into these.

export const SAFE_MESSAGES: Record<string, string> = {
  unauthenticated: "Your session is missing or has expired. Please sign in again.",
  forbidden: "AI analysis is available to administrators only.",
  invalid_request: "The request was not valid. Check the servers, time range, sources and question.",
  payload_too_large: "The request is too large.",
  server_not_found: "One or more selected servers could not be found.",
  session_not_found: "This conversation has expired or does not exist. Start a new analysis.",
  rate_limited: "You are sending analysis requests too quickly. Please wait a moment and try again.",
  too_many_concurrent: "You already have analyses running. Wait for one to finish before starting another.",
  ai_not_configured: "The AI provider is not configured. Ask an administrator to set the Gemini API key on the server.",
  backend_unavailable: "The platform data service is unreachable right now. Please try again shortly.",
  data_unavailable: "None of the selected data sources could be read, so there is nothing to analyse.",
  provider_auth: "The AI provider rejected the configured credentials. Ask an administrator to check the API key.",
  provider_rate_limited: "The AI provider is rate limiting requests. Please try again in a minute.",
  provider_timeout: "The AI provider took too long to respond. Try again, or narrow the time range or sources.",
  provider_unavailable: "The AI provider is temporarily unavailable. Please try again shortly.",
  provider_rejected: "The AI provider could not process this request (it may be too large). Narrow the scope and try again.",
  provider_blocked: "The AI provider declined to answer this request. Try rephrasing your question.",
  provider_bad_response: "The AI provider returned an unusable answer. Please try again.",
  aborted: "The analysis was cancelled.",
  internal_error: "Something went wrong on our side. Please try again.",
};

export function safeMessage(code: string): string {
  return SAFE_MESSAGES[code] ?? SAFE_MESSAGES.internal_error;
}

/** An error that is safe to turn into an HTTP response: status + allow-listed code. */
export class AiHttpError extends Error {
  status: number;
  code: string;
  /** Operator-only explanation (goes to the server log, never to the client body). */
  reason?: string;
  constructor(status: number, code: string, reason?: string) {
    super(code);
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

/** Failure talking to the LLM provider. `message` is internal; clients only see safeMessage(code). */
export class AiProviderError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/** Failure talking to the platform backend. */
export class BackendError extends Error {
  status: number;
  constructor(status: number, message?: string) {
    super(message ?? `backend ${status}`);
    this.status = status;
  }
}

export function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

/** Map any backend failure to a safe HTTP error. Fails closed. */
export function mapBackendError(e: unknown): AiHttpError {
  if (e instanceof AiHttpError) return e;
  const s = statusOf(e);
  const reason = e instanceof Error ? e.message : undefined;
  if (s === 401) return new AiHttpError(401, "unauthenticated", reason);
  if (s === 403) return new AiHttpError(403, "forbidden", reason);
  return new AiHttpError(502, "backend_unavailable", reason);
}
