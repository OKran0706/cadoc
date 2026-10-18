// Copy / Markdown / PDF export of an AI answer. Pure builders + small browser helpers (window only used at call time).

import type { DataUsed } from "./ai/types.ts";
import { SOURCE_META } from "./aiScope.ts";
import { escapeHtml, markdownToHtml } from "./markdown.ts";

export interface ReportInput {
  question: string;
  answer: string;
  dataUsed?: DataUsed;
  truncation?: string[];
  generatedAt: Date;
}

export function dataUsedLines(d: DataUsed): string[] {
  const lines = [
    `- Records analysed: ${d.record_count}`,
    `- Time range: ${d.range.from} to ${d.range.to}`,
    `- Servers: ${d.servers.map((s) => `${s.hostname} (${s.id})`).join(", ")}`,
    `- Sources: ${d.sources.map((s) => `${SOURCE_META[s.source]?.label ?? s.source} (${s.count})`).join(", ")}`,
  ];
  if (d.unavailable.length) lines.push(`- Unavailable sources: ${d.unavailable.map((u) => SOURCE_META[u]?.label ?? u).join(", ")}`);
  return lines;
}

export function buildMarkdownReport(r: ReportInput): string {
  const parts = ["# AI Logs & Analysis report", "", `Generated: ${r.generatedAt.toISOString()}`, "", "## Question", "", r.question.trim(), "", "## Analysis", "", r.answer.trim(), ""];
  if (r.dataUsed) parts.push("## Data used", "", ...dataUsedLines(r.dataUsed), "");
  if (r.truncation?.length) parts.push("## Limitations", "", ...r.truncation.map((t) => `- ${t}`), "");
  parts.push("---", "_AI-generated from the data above. Verify cited record IDs, paths and timestamps before acting._", "");
  return parts.join("\n");
}

export function buildPrintHtml(r: ReportInput): string {
  const meta = r.dataUsed ? `<ul>${dataUsedLines(r.dataUsed).map((l) => `<li>${escapeHtml(l.slice(2))}</li>`).join("")}</ul>` : "";
  const lim = r.truncation?.length ? `<h2>Limitations</h2><ul>${r.truncation.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>AI Logs &amp; Analysis report</title><style>
body{font:13px/1.55 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#191c1e;max-width:760px;margin:24px auto;padding:0 16px}
h1{font-size:20px;color:#001b85;margin:0 0 4px}h2{font-size:15px;color:#001b85;border-bottom:1px solid #c5c5d7;padding-bottom:4px;margin:20px 0 8px}
h3{font-size:13px}code{font:12px ui-monospace,Consolas,monospace;background:#f2f3f6;padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
pre{background:#f2f3f6;padding:10px;border-radius:6px;white-space:pre-wrap}table{border-collapse:collapse;width:100%}th,td{border:1px solid #c5c5d7;padding:4px 8px;text-align:left}
.muted{color:#444655;font-size:11px}blockquote{border-left:3px solid #c5c5d7;margin:8px 0;padding-left:10px;color:#444655}
</style></head><body><h1>AI Logs &amp; Analysis report</h1><p class="muted">Generated ${escapeHtml(r.generatedAt.toISOString())}</p>
<h2>Question</h2><p>${escapeHtml(r.question.trim())}</p><h2>Analysis</h2>${markdownToHtml(r.answer)}
${r.dataUsed ? `<h2>Data used</h2>${meta}` : ""}${lim}
<p class="muted">AI-generated from the data above. Verify cited record IDs, paths and timestamps before acting.</p></body></html>`;
}

export function reportFilename(generatedAt: Date, ext: string): string {
  return `ai-analysis-${generatedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${ext}`;
}

// ── browser helpers ────────────────────────────────────────────────────────
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function downloadText(filename: string, content: string, mime = "text/markdown;charset=utf-8"): boolean {
  try {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

/** Opens the browser print dialog on a clean document ("Save as PDF"). No popup, no dependency. */
export function printHtml(html: string): boolean {
  try {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) {
      document.body.removeChild(frame);
      return false;
    }
    doc.open();
    doc.write(html);
    doc.close();
    const cleanup = () => setTimeout(() => frame.parentNode?.removeChild(frame), 500);
    win.addEventListener("afterprint", cleanup, { once: true });
    setTimeout(() => {
      win.focus();
      win.print();
      setTimeout(cleanup, 60_000);
    }, 100);
    return true;
  } catch {
    return false;
  }
}
