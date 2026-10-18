/**
 * Tiny, safe Markdown subset for LLM answers. It produces an AST (rendered as plain React elements, so no
 * raw-HTML injection into the page) and an escaped HTML string for the print/PDF view. Raw HTML in the input is
 * always treated as text, links are reduced to their label, and record ids / timestamps become "cite" chips.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "bold"; c: Inline[] }
  | { t: "italic"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "cite"; v: string };

export type Block =
  | { t: "heading"; level: 1 | 2 | 3 | 4; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Inline[] }
  | { t: "hr" }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] };

const CITE_ID = "[A-Za-z0-9][\\w.:/-]{2,63}";
const INLINE_RE = new RegExp(
  [
    "`([^`\\n]+)`", // 1 code
    "\\*\\*(.+?)\\*\\*", // 2 bold
    "(?<![\\w*])\\*(?!\\s)([^*\\n]+?)(?<!\\s)\\*(?![\\w*])", // 3 italic
    "\\[([^\\]\\n]+)\\]\\(([^)\\n]*)\\)", // 4 label, 5 url  (link -> label only)
    `\\[(${CITE_ID}(?:,\\s*${CITE_ID})*)\\](?!\\()`, // 6 cite list
    "\\b(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z)\\b", // 7 iso timestamp
  ].join("|"),
  "g"
);

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (v: string) => v && out.push({ t: "text", v });
  for (const m of src.matchAll(INLINE_RE)) {
    push(src.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "bold", c: parseInline(m[2]) });
    else if (m[3] !== undefined) out.push({ t: "italic", c: parseInline(m[3]) });
    else if (m[4] !== undefined) out.push(...parseInline(m[4]));
    else if (m[6] !== undefined) {
      const ids = m[6].split(",").map((s) => s.trim());
      if (ids.every((id) => /\d/.test(id))) {
        ids.forEach((id, i) => {
          if (i > 0) push(" ");
          out.push({ t: "cite", v: id });
        });
      } else push(m[0]);
    } else if (m[7] !== undefined) out.push({ t: "cite", v: m[7] });
  }
  push(src.slice(last));
  return out;
}

const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes("-");
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```\s*([\w-]*)\s*$/.exec(line.trim());
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) body.push(lines[i++]);
      i++; // closing fence (absent while streaming)
      blocks.push({ t: "code", lang: fence[1], v: body.join("\n") });
      continue;
    }
    const h = /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      blocks.push({ t: "heading", level: h[1].length as 1 | 2 | 3 | 4, c: parseInline(h[2]) });
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]).map(parseInline));
      blocks.push({ t: "table", head, rows });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ t: "quote", c: parseInline(q.join(" ")) });
      continue;
    }
    const ul = /^\s*[-*•]\s+(.*)$/;
    const ol = /^\s*\d+[.)]\s+(.*)$/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (m) {
          items.push(parseInline(m[1]));
          i++;
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1].push(...parseInline(` ${lines[i].trim()}`)); // wrapped continuation
          i++;
        } else break;
      }
      blocks.push({ t: ordered ? "ol" : "ul", items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|\s*>|\s*[-*•]\s+|\s*\d+[.)]\s+)/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i++].trim());
    }
    if (para.length === 0) {
      para.push(lines[i++].trim());
    }
    blocks.push({ t: "p", c: parseInline(para.join(" ")) });
  }
  return blocks;
}

// ── HTML (print view) — everything escaped ─────────────────────────────────
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const inlineHtml = (xs: Inline[]): string =>
  xs
    .map((x) => {
      switch (x.t) {
        case "text":
          return escapeHtml(x.v);
        case "bold":
          return `<strong>${inlineHtml(x.c)}</strong>`;
        case "italic":
          return `<em>${inlineHtml(x.c)}</em>`;
        case "code":
          return `<code>${escapeHtml(x.v)}</code>`;
        case "cite":
          return `<code class="cite">${escapeHtml(x.v)}</code>`;
      }
    })
    .join("");

export function blocksToHtml(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case "heading":
          return `<h${b.level}>${inlineHtml(b.c)}</h${b.level}>`;
        case "p":
          return `<p>${inlineHtml(b.c)}</p>`;
        case "ul":
          return `<ul>${b.items.map((it) => `<li>${inlineHtml(it)}</li>`).join("")}</ul>`;
        case "ol":
          return `<ol>${b.items.map((it) => `<li>${inlineHtml(it)}</li>`).join("")}</ol>`;
        case "code":
          return `<pre><code>${escapeHtml(b.v)}</code></pre>`;
        case "quote":
          return `<blockquote>${inlineHtml(b.c)}</blockquote>`;
        case "hr":
          return "<hr/>";
        case "table":
          return `<table><thead><tr>${b.head.map((c) => `<th>${inlineHtml(c)}</th>`).join("")}</tr></thead><tbody>${b.rows
            .map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`;
      }
    })
    .join("\n");
}

export const markdownToHtml = (src: string): string => blocksToHtml(parseMarkdown(src));
