"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, FileDown, Loader2, Printer, RefreshCw, Sparkles, Square, Wrench } from "lucide-react";
import { DataUsedBar } from "./DataUsedBar";
import { SafeMarkdown } from "./SafeMarkdown";
import { ForensicsQueryResultTable } from "./ForensicsQueryResultTable";
import { buildMarkdownReport, buildPrintHtml, copyText, downloadText, printHtml, reportFilename } from "@/lib/aiExport";
import type { ChatMessage } from "./useAiAnalysis";

interface Props {
  message: ChatMessage;
  isLast: boolean;
  onRetry: () => void;
}

const actionBtn =
  "inline-flex items-center gap-1.5 rounded-full border border-outline-variant/30 bg-white px-3 py-1.5 text-[11px] font-bold text-on-surface-variant transition-colors hover:border-primary/30 hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

export function MessageBubble({ message: m, isLast, onRetry }: Props) {
  const [copied, setCopied] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[13px] leading-6 text-white shadow-md shadow-primary/15 [overflow-wrap:anywhere]">{m.content}</p>
      </div>
    );
  }

  const streaming = m.status === "streaming";
  const hasAnswer = m.content.trim().length > 0;
  const finished = (m.status === "done" || m.status === "stopped") && hasAnswer;
  const report = () => ({ question: m.question ?? "", answer: m.content, dataUsed: m.dataUsed, truncation: m.truncation, generatedAt: new Date() });

  const flash = (fn: () => void) => {
    fn();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  const doCopy = async () => {
    setExportError(null);
    if (await copyText(m.content)) flash(() => setCopied(true));
    else setExportError("Copy was blocked by the browser.");
  };
  const doMarkdown = () => {
    setExportError(null);
    const r = report();
    if (!downloadText(reportFilename(r.generatedAt, "md"), buildMarkdownReport(r))) setExportError("Could not create the Markdown file.");
  };
  const doPdf = () => {
    setExportError(null);
    if (!printHtml(buildPrintHtml(report()))) setExportError("Could not open the print dialog.");
  };

  const phaseLabel = m.phase === "collecting" ? "Collecting data…" : m.tools.some((t) => t.status === "running") ? "Fetching more logs…" : "Analysing…";

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden>
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {streaming && (
          <div className="flex items-center gap-2 text-[11px] font-semibold text-primary" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {phaseLabel}
          </div>
        )}

        {m.tools.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Additional data requests">
            {m.tools.map((t, i) => (
              <li
                key={`${t.name}-${i}`}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] font-medium ring-1 ${
                  t.status === "error" ? "bg-error/5 text-error ring-error/20" : "bg-surface-container-low text-on-surface-variant ring-outline-variant/20"
                }`}
              >
                {t.status === "running" ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Wrench className="h-3 w-3" aria-hidden />}
                <span className="font-mono">{t.name}</span> {t.summary}
              </li>
            ))}
          </ul>
        )}

        {hasAnswer && <SafeMarkdown source={m.content} />}

        {m.queryResult && <ForensicsQueryResultTable result={m.queryResult} sql={m.sql} />}

        {streaming && !hasAnswer && (
          <div className="space-y-2" aria-hidden>
            <div className="h-3 w-3/4 animate-pulse rounded bg-surface-container-high" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-surface-container-high" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-surface-container-high" />
          </div>
        )}

        {m.status === "stopped" && (
          <p className="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
            <Square className="h-3 w-3" aria-hidden /> Stopped. {hasAnswer ? "The answer above is incomplete." : "No answer was produced."}
          </p>
        )}

        {m.status === "error" && m.error && (
          <div className="rounded-xl border border-error/25 bg-error/5 p-3.5 text-xs text-error" role="alert">
            <p className="flex items-start gap-2 font-semibold">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{m.error.message}</span>
            </p>
            {m.error.retryAfter && <p className="mt-1 pl-5 text-[11px]">Try again in about {m.error.retryAfter} seconds.</p>}
            {m.error.code === "forbidden" && (
              <p className="mt-1 pl-5 text-[11px] text-on-surface-variant">
                {m.error.reason === "backend"
                  ? "Your login token does not state a role, and the platform's admin check refused this account. An operator can set AI_ADMIN_PROBE_PATH to an endpoint your role can read."
                  : "Your signed-in role is not an administrator role. Sign in with a tenant-admin or platform-owner account."}
              </p>
            )}
            {m.error.code === "ai_not_configured" && (
              <p className="mt-1 pl-5 text-[11px] text-on-surface-variant">
                Server setting: <code className="font-mono">AI_API_KEY</code> (Gemini). See docs/ai-analysis-setup.md.
              </p>
            )}
            {isLast && m.error.code !== "ai_not_configured" && m.error.code !== "forbidden" && (
              <button type="button" onClick={onRetry} className="mt-2 ml-5 inline-flex items-center gap-1.5 rounded-full border border-error/30 bg-white px-3 py-1.5 text-[11px] font-bold text-error hover:bg-error/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-error/40">
                <RefreshCw className="h-3 w-3" aria-hidden /> Retry
              </button>
            )}
          </div>
        )}

        {m.dataUsed && <DataUsedBar data={m.dataUsed} truncation={m.truncation} />}

        {finished && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Answer actions">
            <button type="button" onClick={doCopy} className={actionBtn}>
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" onClick={doMarkdown} className={actionBtn}>
              <FileDown className="h-3.5 w-3.5" aria-hidden /> Markdown
            </button>
            <button type="button" onClick={doPdf} className={actionBtn}>
              <Printer className="h-3.5 w-3.5" aria-hidden /> PDF
            </button>
            {exportError && <span className="text-[11px] text-error" role="alert">{exportError}</span>}
            <span className="sr-only" aria-live="polite">{copied ? "Answer copied to clipboard" : ""}</span>
          </div>
        )}
      </div>
    </div>
  );
}
