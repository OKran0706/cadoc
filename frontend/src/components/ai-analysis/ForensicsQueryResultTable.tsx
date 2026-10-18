"use client";

import { useState } from "react";
import { Table, ChevronDown, ChevronUp, Search, Database } from "lucide-react";
import type { ForensicsQueryResult } from "@/lib/types";

interface Props {
  result: ForensicsQueryResult | null;
  loading?: boolean;
  sql?: string;
}

export function ForensicsQueryResultTable({ result, loading, sql }: Props) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [filterText, setFilterText] = useState("");
  const [showSql, setShowSql] = useState(false);

  if (loading) {
    return (
      <div className="rounded-xl border border-outline-variant/15 bg-surface-container-lowest p-4 text-xs">
        <div className="flex items-center gap-2 text-primary font-semibold">
          <Database className="h-4 w-4 animate-pulse" />
          <span>Executing Forensics API query against Swagger backend…</span>
        </div>
        {sql && (
          <pre className="mt-2 rounded bg-[#0a111e] p-2 text-[10px] font-mono text-white/80 overflow-x-auto">
            {sql}
          </pre>
        )}
      </div>
    );
  }

  if (!result || !result.columns || result.columns.length === 0) {
    return null;
  }

  const columns = result.columns;
  const rawRows = Array.isArray(result.rows) ? result.rows : [];

  const filteredRows = filterText
    ? rawRows.filter((row) =>
        row.some((cell) =>
          String(cell ?? "")
            .toLowerCase()
            .includes(filterText.toLowerCase())
        )
      )
    : rawRows;

  return (
    <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-sm overflow-hidden text-xs my-3">
      {/* Table Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant/10 bg-surface-container-low/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-primary" />
          <span className="font-bold text-on-surface text-[11px] uppercase tracking-wider">
            Forensics Evidence Dataset
          </span>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
            {rawRows.length} {rawRows.length === 1 ? "record" : "records"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {sql && (
            <button
              type="button"
              onClick={() => setShowSql((prev) => !prev)}
              className="text-[10px] font-medium text-primary hover:underline"
            >
              {showSql ? "Hide SQL" : "View SQL"}
            </button>
          )}

          <button
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-on-surface-variant hover:bg-surface-container-high transition-colors"
          >
            {isExpanded ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" /> Collapse
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" /> Expand
              </>
            )}
          </button>
        </div>
      </div>

      {/* SQL Snippet View */}
      {showSql && sql && (
        <div className="border-b border-outline-variant/10 bg-[#0d1424] p-3 font-mono text-[11px] text-emerald-400 overflow-x-auto select-all">
          <div className="text-[9px] uppercase tracking-wider text-white/40 mb-1 font-sans">
            Forensics Query (Swagger API 1)
          </div>
          <pre>{sql}</pre>
        </div>
      )}

      {/* Collapsible Content */}
      {isExpanded && (
        <div className="p-3">
          {/* Search filter if there are multiple rows */}
          {rawRows.length > 3 && (
            <div className="mb-2.5 flex items-center gap-2">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-on-surface-variant" />
                <input
                  type="text"
                  placeholder="Filter records..."
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="w-full rounded-lg border border-outline-variant/30 bg-white pl-7 pr-2.5 py-1 text-[11px] text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {filterText && (
                <span className="text-[10px] text-on-surface-variant">
                  Showing {filteredRows.length} of {rawRows.length}
                </span>
              )}
            </div>
          )}

          {/* Table Container */}
          <div className="max-h-56 overflow-auto rounded-lg border border-outline-variant/15">
            <table className="w-full border-collapse text-left text-[11px]">
              <thead className="sticky top-0 bg-surface-container-high text-on-surface">
                <tr>
                  {columns.map((col, idx) => (
                    <th
                      key={idx}
                      className="px-2.5 py-1.5 font-bold uppercase tracking-wider text-[10px] border-b border-outline-variant/20 whitespace-nowrap"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/10">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="py-4 text-center text-on-surface-variant italic"
                    >
                      No records matched the filter query.
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row, rIdx) => (
                    <tr
                      key={rIdx}
                      className="hover:bg-primary/5 transition-colors font-mono text-[10px]"
                    >
                      {columns.map((col, cIdx) => {
                        const val = row[cIdx];
                        const text =
                          typeof val === "object" && val !== null
                            ? JSON.stringify(val)
                            : String(val ?? "—");

                        const isCrit = /crit|fail|tamper/i.test(text);
                        const isWarn = /warn|medium/i.test(text);

                        return (
                          <td
                            key={cIdx}
                            className={`px-2.5 py-1.5 whitespace-nowrap max-w-xs truncate ${
                              isCrit
                                ? "text-error font-semibold"
                                : isWarn
                                ? "text-amber-600 font-semibold"
                                : "text-on-surface"
                            }`}
                            title={text}
                          >
                            {text}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
