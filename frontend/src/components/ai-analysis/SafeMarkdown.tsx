"use client";

import { Fragment, useMemo } from "react";
import { Clock, FileText, ListChecks, Server, ShieldAlert } from "lucide-react";
import { parseMarkdown } from "@/lib/markdown";
import type { Block, Inline } from "@/lib/markdown";

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return <Fragment key={i}>{n.v}</Fragment>;
          case "bold":
            return (
              <strong key={i} className="font-semibold text-on-surface">
                <Inlines nodes={n.c} />
              </strong>
            );
          case "italic":
            return (
              <em key={i}>
                <Inlines nodes={n.c} />
              </em>
            );
          case "code":
            return (
              <code key={i} className="rounded bg-surface-container-low px-1 py-0.5 font-mono text-[11.5px] [overflow-wrap:anywhere]">
                {n.v}
              </code>
            );
          case "cite":
            return (
              <code key={i} className="rounded-md border border-primary/15 bg-primary/5 px-1 py-0.5 font-mono text-[11px] font-medium text-primary [overflow-wrap:anywhere]">
                {n.v}
              </code>
            );
        }
      })}
    </>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case "heading": {
      const cls = b.level <= 2 ? "mt-3 text-sm font-bold text-primary" : "mt-3 text-xs font-bold text-on-surface";
      return <p className={cls} role="heading" aria-level={b.level + 1}><Inlines nodes={b.c} /></p>;
    }
    case "p":
      return <p className="text-[13px] leading-6 text-on-surface"><Inlines nodes={b.c} /></p>;
    case "ul":
      return (
        <ul className="ml-4 list-disc space-y-1 text-[13px] leading-6 text-on-surface marker:text-primary/50">
          {b.items.map((it, i) => (
            <li key={i}><Inlines nodes={it} /></li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="ml-4 list-decimal space-y-1 text-[13px] leading-6 text-on-surface marker:font-semibold marker:text-primary/60">
          {b.items.map((it, i) => (
            <li key={i}><Inlines nodes={it} /></li>
          ))}
        </ol>
      );
    case "code":
      return <pre className="overflow-x-auto rounded-xl bg-[#0e1117] p-3 font-mono text-[11.5px] leading-5 text-white/90"><code>{b.v}</code></pre>;
    case "quote":
      return <blockquote className="border-l-2 border-primary/30 pl-3 text-[13px] italic text-on-surface-variant"><Inlines nodes={b.c} /></blockquote>;
    case "hr":
      return <hr className="border-outline-variant/30" />;
    case "table":
      return (
        <div className="overflow-x-auto rounded-xl border border-outline-variant/20">
          <table className="w-full text-xs">
            <thead className="bg-surface-container-low">
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-on-surface-variant"><Inlines nodes={c} /></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i} className="border-t border-outline-variant/10">
                  {r.map((c, j) => (
                    <td key={j} className="px-3 py-2 align-top"><Inlines nodes={c} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

const SECTION_ICONS: [RegExp, typeof FileText][] = [
  [/summary/i, FileText],
  [/timeline/i, Clock],
  [/affected|asset/i, Server],
  [/risk/i, ShieldAlert],
  [/action|recommend/i, ListChecks],
];

function sectionIcon(title: string) {
  return SECTION_ICONS.find(([re]) => re.test(title))?.[1] ?? FileText;
}

const flatten = (nodes: Inline[]): string => nodes.map((n) => ("v" in n ? n.v : flatten(n.c))).join("");
const headingText = (b: Block): string => (b.t === "heading" ? flatten(b.c) : "");

/** Renders an LLM answer as plain React elements; the five analysis sections become titled cards. */
export function SafeMarkdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const groups = useMemo(() => {
    const out: { title: string | null; blocks: Block[] }[] = [{ title: null, blocks: [] }];
    for (const b of blocks) {
      if (b.t === "heading" && b.level <= 2) out.push({ title: headingText(b) || "Section", blocks: [] });
      else out[out.length - 1].blocks.push(b);
    }
    return out.filter((g) => g.title !== null || g.blocks.length > 0);
  }, [blocks]);

  return (
    <div className="space-y-3">
      {groups.map((g, gi) => {
        if (g.title === null) {
          return (
            <div key={gi} className="space-y-2">
              {g.blocks.map((b, i) => <BlockView key={i} b={b} />)}
            </div>
          );
        }
        const Icon = sectionIcon(g.title);
        return (
          <section key={gi} className="rounded-xl border border-outline-variant/15 bg-surface-container-lowest p-3.5">
            <h3 className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-primary">
              <Icon className="h-3.5 w-3.5" aria-hidden /> {g.title}
            </h3>
            <div className="space-y-2">
              {g.blocks.map((b, i) => <BlockView key={i} b={b} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
