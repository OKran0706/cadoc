// Pure scope logic for the AI Logs & Analysis tab (UI state -> request body, with validation).

import { SOURCES } from "./ai/types.ts";
import type { Source } from "./ai/types.ts";

export const MAX_SERVERS = 10;
export const MAX_RANGE_DAYS = 30;
export const MAX_MESSAGE_CHARS = 2000;

export const PRESETS = [
  { id: "1h", label: "1 hour", ms: 3_600_000 },
  { id: "6h", label: "6 hours", ms: 6 * 3_600_000 },
  { id: "24h", label: "24 hours", ms: 24 * 3_600_000 },
  { id: "7d", label: "7 days", ms: 7 * 86_400_000 },
  { id: "30d", label: "30 days", ms: 30 * 86_400_000 },
] as const;
export type PresetId = (typeof PRESETS)[number]["id"] | "custom";

export const SOURCE_META: Record<Source, { label: string; hint: string }> = {
  decoy_events: { label: "Decoy events", hint: "Planting, verification and status of decoy files" },
  tamper_history: { label: "Tamper & verification history", hint: "Tampered or failed-verification decoys" },
  forensic_findings: { label: "Forensic findings", hint: "Alerts raised by the sensors" },
  system_logs: { label: "System / auth logs", hint: "Audit trail, if your account may read it" },
};

export const DECOY_TYPES = ["ssh_key", "env_file", "config_backup", "db_dump"] as const;
export const DECOY_STATUSES = ["planted", "tampered", "cleaned_up", "verification_failed"] as const;

export interface ScopeState {
  projectId: string;
  serverIds: string[];
  preset: PresetId;
  customFrom: string; // <input type="datetime-local"> value, local time
  customTo: string;
  sources: Source[];
  decoyType: string; // "" = any
  status: string; // "" = any
  severity?: string; // "" = any
  customSql?: string;
  mode?: "project_forensics" | "servers";
}

export function defaultScope(): ScopeState {
  return {
    projectId: "",
    serverIds: [],
    preset: "24h",
    customFrom: "",
    customTo: "",
    sources: ["decoy_events", "tamper_history", "forensic_findings"],
    decoyType: "",
    status: "",
    severity: "",
    customSql: "",
    mode: "servers",
  };
}

export function resolveRange(scope: ScopeState, now: number): { from: string; to: string } | null {
  if (scope.preset !== "custom") {
    const p = PRESETS.find((x) => x.id === scope.preset);
    return p ? { from: new Date(now - p.ms).toISOString(), to: new Date(now).toISOString() } : null;
  }
  const from = Date.parse(scope.customFrom);
  const to = Date.parse(scope.customTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export function validateScope(scope: ScopeState, now: number): string[] {
  const errors: string[] = [];
  if (scope.mode === "project_forensics") {
    if (!scope.projectId) errors.push("Select a project for forensics analysis.");
  } else {
    if (scope.serverIds.length === 0) errors.push("Select at least one server.");
    if (scope.serverIds.length > MAX_SERVERS) errors.push(`Select at most ${MAX_SERVERS} servers.`);
    if (scope.sources.length === 0) errors.push("Select at least one data source.");
  }
  if (scope.preset === "custom") {
    const r = resolveRange(scope, now);
    if (!r) errors.push("Enter both a start and an end time.");
    else {
      const span = Date.parse(r.to) - Date.parse(r.from);
      if (span <= 0) errors.push("The start time must be before the end time.");
      else if (span > MAX_RANGE_DAYS * 86_400_000) errors.push(`The time range can be at most ${MAX_RANGE_DAYS} days.`);
      else if (Date.parse(r.to) > now + 5 * 60_000) errors.push("The end time cannot be in the future.");
    }
  }
  return errors;
}

export function toQueryBody(scope: ScopeState, message: string, now: number) {
  const range = resolveRange(scope, now);
  if (!range) throw new Error("Invalid time range");
  const filters: { decoy_type?: string; status?: string } = {};
  if (scope.decoyType) filters.decoy_type = scope.decoyType;
  if (scope.status) filters.status = scope.status;
  return {
    servers: scope.serverIds,
    range,
    sources: SOURCES.filter((s) => scope.sources.includes(s)),
    filters,
    message: message.trim(),
  };
}

export const PROMPT_CHIPS: { label: string; prompt: string }[] = [
  { label: "Summarize last 24h", prompt: "Summarize everything that happened on the selected servers in this time range." },
  { label: "Show tampered decoys", prompt: "Which decoys were tampered with, and in what order? Include file paths and times." },
  { label: "Possible attacker actions", prompt: "Based only on the data, what could an attacker have done? Separate facts from inference and give confidence levels." },
  { label: "Recommend next steps", prompt: "What should I do next? Give prioritised recommended actions and explain why each matters." },
];
