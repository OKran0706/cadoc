// Audit trail for every AI query / follow-up / denial (INV-AI-10).
// Records go to a bounded in-memory ring AND to stdout as `AUDIT {json}` (Cloud Logging picks this up).
// Tokens and API keys are never part of a record; free text is redacted.

import { redactText, redactValue } from "./redact.ts";
import type { Filters, ServerRef, Source, TimeRange } from "./types.ts";

export interface AuditActor {
  id: string;
  email?: string;
  role?: string;
  company?: string;
}

export interface AuditEntry {
  action: "query" | "followup" | "denied";
  actor: AuditActor;
  servers?: ServerRef[];
  scope?: { range: TimeRange; sources: Source[]; filters: Filters };
  session_id?: string;
  outcome: string;
  question?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): void;
  readonly entries: Array<AuditEntry & { ts: string }>;
}

export function createAuditLog(opts: { now?: () => number; sink?: (line: string) => void; maxEntries?: number } = {}): AuditLog {
  const now = opts.now ?? Date.now;
  const sink = opts.sink ?? ((line: string) => console.info(line));
  const max = opts.maxEntries ?? 500;
  const entries: Array<AuditEntry & { ts: string }> = [];
  return {
    entries,
    record(entry) {
      const base = { ts: new Date(now()).toISOString(), ...entry };
      if (typeof base.question === "string") base.question = redactText(base.question).text.slice(0, 200);
      const rec = redactValue(base).value;
      entries.push(rec);
      if (entries.length > max) entries.splice(0, entries.length - max);
      sink(`AUDIT ${JSON.stringify(rec)}`);
    },
  };
}
