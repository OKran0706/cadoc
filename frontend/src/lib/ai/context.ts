// Builds the LLM context: redact -> pre-aggregate -> fit to the token budget -> wrap as untrusted data.
// Aggregates are always computed over ALL records, so counts stay exact even when detail rows are dropped.

import { randomBytes } from "node:crypto";
import { redactValue } from "./redact.ts";
import type { AuditRec, DataRecord, DataUsed, DecoyRec, FindingRec, ServerRef, Source, TimeRange, Unavailable } from "./types.ts";

export interface ContextInput {
  records: DataRecord[];
  servers: ServerRef[];
  range: TimeRange;
  sources: Source[];
  unavailable: Unavailable[];
  notes: string[];
  tokenBudget: number;
  nonce?: string;
}

export interface BuiltContext {
  text: string;
  dataUsed: DataUsed;
  truncation: string[];
  estimatedTokens: number;
  redactions: number;
}

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

const OPEN = (n: string) => `<<<UNTRUSTED_LOG_DATA id=${n}>>>`;
const CLOSE = (n: string) => `<<<END_UNTRUSTED_LOG_DATA id=${n}>>>`;

/** Neutralise delimiter look-alikes so log content can never close or forge the block. */
export function wrapUntrusted(content: string, nonce: string): string {
  const safe = content.replaceAll("<<<", "‹‹‹").replaceAll(">>>", "›››");
  return `${OPEN(nonce)}\n${safe}\n${CLOSE(nonce)}`;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const sevRank = (s: string) => SEVERITY_RANK[s?.toLowerCase()] ?? 5;
const TAMPER_STATUSES = new Set(["tampered", "verification_failed"]);
const ts = (s: string | null | undefined) => (s ? Date.parse(s) || 0 : 0);
const counts = (items: string[]) => {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};
const kv = (pairs: [string, number][]) => pairs.map(([k, v]) => `${k}=${v}`).join(" ");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);
const j = (v: unknown, n: number) => clip(typeof v === "string" ? v : JSON.stringify(v ?? {}), n);

function aggregates(decoys: DecoyRec[], findings: FindingRec[], audits: AuditRec[], servers: ServerRef[]): string[] {
  const out: string[] = [];
  for (const s of servers) {
    const d = decoys.filter((x) => x.server_id === s.id);
    const f = findings.filter((x) => x.server_id === s.id);
    const a = audits.filter((x) => x.server_id === s.id);
    const label = `server ${s.hostname} (${s.id})`;
    if (d.length) {
      const byStatus = counts(d.map((x) => x.status));
      const tampered = d.filter((x) => x.status === "tampered").map((x) => ts(x.updated_at)).filter(Boolean).sort((p, q) => p - q);
      const tamperBit = tampered.length
        ? `; first_tamper=${new Date(tampered[0]).toISOString()}; last_tamper=${new Date(tampered[tampered.length - 1]).toISOString()}`
        : "";
      out.push(`${label}: decoys total=${d.length} ${kv(byStatus)}${tamperBit}`);
      out.push(`${label}: decoy_types ${kv(counts(d.map((x) => x.decoy_type)))}`);
    }
    if (f.length) {
      const times = f.map((x) => ts(x.detected_at)).filter(Boolean).sort((p, q) => p - q);
      out.push(
        `${label}: findings total=${f.length} by_severity ${kv(counts(f.map((x) => x.severity)))}; by_type ${kv(counts(f.map((x) => x.event_type)))}` +
          (times.length ? `; first=${new Date(times[0]).toISOString()}; last=${new Date(times[times.length - 1]).toISOString()}` : "")
      );
    }
    if (a.length) out.push(`${label}: audit_events total=${a.length} by_action ${kv(counts(a.map((x) => x.action)))}`);
    if (!d.length && !f.length && !a.length) out.push(`${label}: no records in scope`);
  }
  return out;
}

interface Level {
  decoyTampered: number;
  decoyOther: number;
  findings: number;
  audits: number;
  detail: number;
}
const LEVELS: Level[] = [
  { decoyTampered: Infinity, decoyOther: Infinity, findings: Infinity, audits: Infinity, detail: 300 },
  { decoyTampered: 100, decoyOther: 20, findings: 150, audits: 50, detail: 120 },
  { decoyTampered: 30, decoyOther: 0, findings: 40, audits: 15, detail: 80 },
];

export function buildContext(input: ContextInput): BuiltContext {
  const nonce = input.nonce ?? randomBytes(8).toString("hex");
  const { value: records, count: redactions } = redactValue(input.records);
  const decoys = records.filter((r): r is DecoyRec => r.kind === "decoy");
  const findings = records.filter((r): r is FindingRec => r.kind === "finding");
  const audits = records.filter((r): r is AuditRec => r.kind === "audit");

  const agg = aggregates(decoys, findings, audits, input.servers);
  const tamperCount = decoys.filter((d) => TAMPER_STATUSES.has(d.status)).length;
  const bySource: Record<Source, number> = {
    decoy_events: decoys.length,
    tamper_history: tamperCount,
    forensic_findings: findings.length,
    system_logs: audits.length,
  };

  const head = (notes: string[]): string[] => [
    "SCOPE",
    `servers: ${input.servers.map((s) => `${s.hostname} (${s.id})`).join(", ")}`,
    `range: ${input.range.from} to ${input.range.to}`,
    `sources_requested: ${input.sources.join(", ")}`,
    ...input.unavailable.map((u) => `source_unavailable: ${u.source} (${u.reason})`),
    "note: tamper times are approximated from the decoy record's updated_at; no per-event history exists.",
    ...notes.map((n) => `limit: ${n}`),
  ];

  function render(level: Level | null): { body: string; notes: string[] } {
    const notes = [...input.notes];
    const lines: string[] = [];
    if (records.length === 0) lines.push("no records matched the selected scope");
    lines.push("AGGREGATES", ...agg);

    if (level) {
      const tam = decoys.filter((d) => TAMPER_STATUSES.has(d.status)).sort((a, b) => ts(a.updated_at) - ts(b.updated_at));
      const rest = decoys.filter((d) => !TAMPER_STATUSES.has(d.status)).sort((a, b) => ts(b.updated_at) - ts(a.updated_at));
      const shownTam = tam.slice(0, level.decoyTampered);
      const shownRest = rest.slice(0, level.decoyOther);
      const shownDecoys = [...shownTam, ...shownRest].sort((a, b) => ts(a.updated_at) - ts(b.updated_at));
      if (shownDecoys.length < decoys.length) {
        notes.push(`Decoy list shows ${shownDecoys.length} of ${decoys.length} (tampered / verification_failed decoys are prioritised); aggregate counts above are exact.`);
      }
      if (shownDecoys.length) {
        lines.push("DECOYS (id | path | type | status | planted_at | last_verified | updated_at | sha256)");
        for (const d of shownDecoys) lines.push(`${d.id} | ${d.file_path} | ${d.decoy_type} | ${d.status} | ${d.planted_at} | ${d.last_verified ?? "never"} | ${d.updated_at} | ${d.original_hash}`);
      }

      const fSorted = [...findings].sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || ts(b.detected_at) - ts(a.detected_at));
      const shownF = fSorted.slice(0, level.findings).sort((a, b) => ts(a.detected_at) - ts(b.detected_at));
      if (shownF.length < findings.length) {
        notes.push(`Findings list shows ${shownF.length} of ${findings.length} (highest severity first); aggregate counts above are exact.`);
      }
      if (shownF.length) {
        lines.push("FINDINGS (id | detected_at | severity | type | host | details)");
        for (const f of shownF) lines.push(`${f.id} | ${f.detected_at} | ${f.severity} | ${f.event_type} | ${f.hostname} | ${j(f.details, level.detail)}`);
      }

      const aSorted = [...audits].sort((a, b) => ts(b.ts) - ts(a.ts));
      const shownA = aSorted.slice(0, level.audits).sort((a, b) => ts(a.ts) - ts(b.ts));
      if (shownA.length < audits.length) notes.push(`System/audit log shows ${shownA.length} of ${audits.length} (most recent first); aggregate counts above are exact.`);
      if (shownA.length) {
        lines.push("SYSTEM_LOGS (id | ts | action | actor | host | details)");
        for (const a of shownA) lines.push(`${a.id} | ${a.ts} | ${a.action} | ${a.actor} | ${a.hostname} | ${j(a.details, level.detail)}`);
      }
    } else if (records.length) {
      notes.push("Only aggregate counts are included; individual records were dropped to fit the token budget.");
    }
    return { body: [...head(notes), ...lines].join("\n"), notes };
  }

  const fits = (body: string) => estimateTokens(wrapUntrusted(body, nonce)) <= input.tokenBudget;

  let chosen: { body: string; notes: string[] } | null = null;
  for (const level of [...LEVELS, null]) {
    const r = render(level);
    chosen = r;
    if (fits(r.body)) break;
  }
  let { body, notes } = chosen!;

  // Last resort for absurdly small budgets: hard-cut the body (the wrapper is always kept intact).
  if (!fits(body)) {
    const overhead = wrapUntrusted("", nonce).length + 40;
    const room = Math.max(0, input.tokenBudget * 4 - overhead);
    body = `${body.slice(0, room)}\n[truncated to fit token budget]`;
    notes = [...notes, "The context was hard-truncated to fit the token budget."];
  }

  const text = wrapUntrusted(body, nonce);
  const dataUsed: DataUsed = {
    record_count: records.length,
    sources: input.sources.map((source) => ({ source, count: bySource[source] })),
    range: input.range,
    servers: input.servers.map((s) => ({ id: s.id, hostname: s.hostname })),
    truncated: notes.length > 0,
    unavailable: input.unavailable.map((u) => u.source),
  };
  return { text, dataUsed, truncation: notes, estimatedTokens: estimateTokens(text), redactions };
}
