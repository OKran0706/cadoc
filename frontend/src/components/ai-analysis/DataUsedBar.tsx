"use client";

import { AlertTriangle, Database } from "lucide-react";
import { SOURCE_META } from "@/lib/aiScope";
import type { DataUsed } from "@/lib/ai/types";

const fmt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/** "Data used" footer under every answer: what the analysis is (and is not) based on. */
export function DataUsedBar({ data, truncation }: { data: DataUsed; truncation?: string[] }) {
  const notes = truncation ?? [];
  return (
    <div className="rounded-xl border border-outline-variant/15 bg-surface-container-low/60 p-3 text-[11px] text-on-surface-variant" aria-label="Data used for this answer">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-primary">
        <Database className="h-3 w-3" aria-hidden /> Data used
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="font-semibold">Records</dt>
        <dd className="text-on-surface">{data.record_count.toLocaleString()}</dd>
        <dt className="font-semibold">Time range</dt>
        <dd className="text-on-surface">
          {fmt(data.range.from)} → {fmt(data.range.to)}
        </dd>
        <dt className="font-semibold">Servers</dt>
        <dd className="text-on-surface">{data.servers.map((s) => s.hostname).join(", ")}</dd>
        <dt className="font-semibold">Sources</dt>
        <dd className="flex flex-wrap gap-1">
          {data.sources.map((s) => (
            <span key={s.source} className="rounded-full bg-white px-2 py-0.5 text-on-surface ring-1 ring-outline-variant/20">
              {SOURCE_META[s.source]?.label ?? s.source} <span className="font-mono text-primary">{s.count}</span>
            </span>
          ))}
        </dd>
      </dl>
      {(data.unavailable.length > 0 || notes.length > 0) && (
        <ul className="mt-2 space-y-1 rounded-lg bg-amber-50 p-2 text-amber-900 ring-1 ring-amber-200">
          {data.unavailable.length > 0 && (
            <li className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>Not available: {data.unavailable.map((u) => SOURCE_META[u]?.label ?? u).join(", ")}.</span>
            </li>
          )}
          {notes.map((n) => (
            <li key={n} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
