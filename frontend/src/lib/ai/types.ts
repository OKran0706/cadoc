// Shared types for the AI Logs & Analysis feature (server + client safe: types only).

export const SOURCES = ["decoy_events", "tamper_history", "forensic_findings", "system_logs"] as const;
export type Source = (typeof SOURCES)[number];

export const DECOY_STATUSES = ["planted", "tampered", "cleaned_up", "verification_failed"] as const;
export type DecoyStatus = (typeof DECOY_STATUSES)[number];

export interface TimeRange {
  from: string;
  to: string;
}

export interface Filters {
  decoy_type?: string;
  status?: DecoyStatus;
}

export interface ServerRef {
  id: string;
  hostname: string;
}

export interface QueryRequest {
  servers: string[];
  range: TimeRange;
  sources: Source[];
  filters: Filters;
  message: string;
}

export interface FollowupRequest {
  session_id: string;
  message: string;
}

// ── Normalised records handed to the context builder ───────────────────────
export interface DecoyRec {
  kind: "decoy";
  id: string;
  server_id: string;
  hostname: string;
  file_path: string;
  decoy_type: string;
  original_hash: string;
  status: string;
  planted_at: string;
  last_verified: string | null;
  updated_at: string;
}

export interface FindingRec {
  kind: "finding";
  id: string;
  server_id: string;
  hostname: string;
  event_type: string;
  severity: string;
  detected_at: string;
  details: Record<string, unknown>;
}

export interface AuditRec {
  kind: "audit";
  id: string;
  server_id: string;
  hostname: string;
  action: string;
  actor: string;
  ts: string;
  details: unknown;
}

export type DataRecord = DecoyRec | FindingRec | AuditRec;

export interface Unavailable {
  source: Source;
  reason: string;
}

export interface DataUsed {
  record_count: number;
  sources: { source: Source; count: number }[];
  range: TimeRange;
  servers: ServerRef[];
  truncated: boolean;
  unavailable: Source[];
}

// ── Streaming protocol (server -> browser, one JSON object per SSE event) ──
export type SseEvent =
  | { type: "meta"; session_id: string; data_used: DataUsed; truncation: string[] }
  | { type: "data_used"; data_used: DataUsed; truncation: string[] }
  | { type: "tool"; name: string; status: "running" | "done" | "error"; summary: string }
  | { type: "delta"; text: string }
  | { type: "done"; stop_reason: string }
  | { type: "error"; code: string; message: string };

// ── Provider-neutral LLM message model ─────────────────────────────────────
export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; signature?: string }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | Block[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type LlmEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; signature?: string }
  | { type: "stop"; reason: "end_turn" | "tool_use" | "max_tokens" };

export interface AiConfig {
  provider: "gemini";
  model: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
  tokenBudget: number;
  rateLimitMax: number;
  rateLimitWindowSec: number;
  maxConcurrent: number;
}

export interface LlmParams {
  config: Pick<AiConfig, "provider" | "model" | "apiKey" | "baseUrl" | "timeoutMs" | "maxRetries" | "maxOutputTokens">;
  system: string;
  messages: LlmMessage[];
  tools: ToolDef[];
  signal?: AbortSignal;
}

/** Read-only surface over the platform backend. Deliberately has no write verbs. */
export interface Backend {
  get(path: string, params?: Record<string, string | number>): Promise<unknown>;
}
