import test from "node:test";
import assert from "node:assert/strict";
import { parseSseChunk } from "../src/lib/sse.ts";
import { parseMarkdown, parseInline, markdownToHtml, escapeHtml } from "../src/lib/markdown.ts";
import { defaultScope, validateScope, resolveRange, toQueryBody, PROMPT_CHIPS, PRESETS } from "../src/lib/aiScope.ts";
import { buildMarkdownReport, buildPrintHtml, reportFilename } from "../src/lib/aiExport.ts";
import { NOW, iso } from "./helpers/ai-fakes.mjs";

// ── SSE parsing ─────────────────────────────────────────────────────────────
test("sse: complete events are returned, the partial tail is kept for the next chunk", () => {
  let r = parseSseChunk('data: {"a":1}\n\ndata: {"b"');
  assert.deepEqual(r.data, ['{"a":1}']);
  r = parseSseChunk(r.rest + ':2}\n\n');
  assert.deepEqual(r.data, ['{"b":2}']);
  assert.equal(r.rest, "");
});

test("sse: handles CRLF, multi-line data, comments and non-data lines", () => {
  const r = parseSseChunk(": ping\r\n\r\nevent: x\r\ndata: one\r\ndata: two\r\n\r\n");
  assert.deepEqual(r.data, ["one\ntwo"]);
});

test("sse: a chunk split exactly on the delimiter does not lose or duplicate events", () => {
  const a = parseSseChunk("data: 1\n");
  assert.deepEqual(a.data, []);
  const b = parseSseChunk(a.rest + "\ndata: 2\n\n");
  assert.deepEqual(b.data, ["1", "2"]);
});

// ── Markdown ────────────────────────────────────────────────────────────────
test("markdown: headings, lists, tables, code and quotes parse to blocks", () => {
  const md = "## Summary\nText with **bold** and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\nraw <b>\n```\n\n> note";
  const t = parseMarkdown(md).map((b) => b.t);
  assert.deepEqual(t, ["heading", "p", "ul", "ol", "table", "code", "quote"]);
  const table = parseMarkdown(md).find((b) => b.t === "table");
  assert.equal(table.rows.length, 1);
});

test("markdown: record ids and timestamps become cite chips; plain brackets do not", () => {
  const inl = parseInline("Tampered [dcy-1042, dcy-1043] at 2026-10-18T11:42:10Z; confidence [High] and [Fact].");
  const cites = inl.filter((x) => x.t === "cite").map((x) => x.v);
  assert.deepEqual(cites, ["dcy-1042", "dcy-1043", "2026-10-18T11:42:10Z"]);
  assert.ok(inl.some((x) => x.t === "text" && x.v.includes("[High]")));
});

test("markdown: raw HTML and script payloads are inert text in the AST and escaped in HTML", () => {
  const evil = '<img src=x onerror=alert(1)> <script>alert(2)</script> [click](javascript:alert(3)) **<b>x</b>**';
  const html = markdownToHtml(evil);
  assert.ok(!/<script|<img|<b>/i.test(html), html);
  assert.ok(!/javascript:/i.test(html), "link targets are dropped");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("markdown: partial streamed output never throws (unclosed bold/code fence/table)", () => {
  for (const partial of ["**half", "```\ncode without end", "| a | b |\n|---", "## ", "- ", "1.", "`x", "[dcy-1", "> "]) {
    assert.doesNotThrow(() => markdownToHtml(partial), partial);
  }
  const open = parseMarkdown("```\nabc");
  assert.equal(open[0].t, "code");
  assert.equal(open[0].v, "abc");
});

test("markdown: wrapped list item continuation lines stay in the item", () => {
  const b = parseMarkdown("- first line\n  continued here\n- second")[0];
  assert.equal(b.items.length, 2);
});

// ── Scope ───────────────────────────────────────────────────────────────────
test("scope: default is 24h with the three data-backed sources", () => {
  const s = defaultScope();
  assert.equal(s.preset, "24h");
  assert.deepEqual(s.sources, ["decoy_events", "tamper_history", "forensic_findings"]);
});

test("scope: presets resolve relative to now", () => {
  for (const p of PRESETS) {
    const r = resolveRange({ ...defaultScope(), preset: p.id }, NOW);
    assert.equal(Date.parse(r.to) - Date.parse(r.from), p.ms);
    assert.equal(Date.parse(r.to), NOW);
  }
});

test("scope: validation messages for servers, sources and custom ranges", () => {
  const base = { ...defaultScope(), serverIds: ["s1"] };
  assert.deepEqual(validateScope(base, NOW), []);
  assert.ok(validateScope({ ...base, serverIds: [] }, NOW).some((e) => /server/i.test(e)));
  assert.ok(validateScope({ ...base, serverIds: Array.from({ length: 11 }, (_, i) => `s${i}`) }, NOW).some((e) => /at most 10/i.test(e)));
  assert.ok(validateScope({ ...base, sources: [] }, NOW).some((e) => /source/i.test(e)));
  const custom = (from, to) => validateScope({ ...base, preset: "custom", customFrom: from, customTo: to }, NOW);
  assert.ok(custom("", "").some((e) => /start and an end/i.test(e)));
  assert.ok(custom(iso(0), iso(60)).some((e) => /before/i.test(e)));
  assert.ok(custom(iso(40 * 24 * 60), iso(0)).some((e) => /30 days/i.test(e)));
  assert.ok(custom(iso(10), new Date(NOW + 3_600_000).toISOString()).some((e) => /future/i.test(e)));
  assert.deepEqual(custom(iso(120), iso(0)), []);
});

test("scope: request body carries ids, ISO range, canonical source order and only set filters", () => {
  const body = toQueryBody({ ...defaultScope(), serverIds: ["a", "b"], sources: ["forensic_findings", "decoy_events"], status: "tampered" }, "  hello  ", NOW);
  assert.deepEqual(body.servers, ["a", "b"]);
  assert.deepEqual(body.sources, ["decoy_events", "forensic_findings"]);
  assert.deepEqual(body.filters, { status: "tampered" });
  assert.equal(body.message, "hello");
  assert.match(body.range.from, /Z$/);
  assert.deepEqual(Object.keys(body).sort(), ["filters", "message", "range", "servers", "sources"], "exactly the fields the server accepts");
});

test("scope: the four required prompt chips exist", () => {
  assert.deepEqual(PROMPT_CHIPS.map((c) => c.label), ["Summarize last 24h", "Show tampered decoys", "Possible attacker actions", "Recommend next steps"]);
  assert.ok(PROMPT_CHIPS.every((c) => c.prompt.length > 20 && c.prompt.length <= 2000));
});

// ── Export ──────────────────────────────────────────────────────────────────
const report = {
  question: "What happened on pikachu?",
  answer: "## Summary\nTampered [dcy-1] at 2026-10-18T11:00:00Z <script>x</script>",
  dataUsed: {
    record_count: 3,
    sources: [{ source: "decoy_events", count: 2 }, { source: "forensic_findings", count: 1 }],
    range: { from: iso(60), to: iso(0) },
    servers: [{ id: "srv-1", hostname: "pikachu" }],
    truncated: true,
    unavailable: ["system_logs"],
  },
  truncation: ["Findings list shows 150 of 900"],
  generatedAt: new Date(NOW),
};

test("export: markdown report has question, answer, data used and limitations", () => {
  const md = buildMarkdownReport(report);
  for (const must of ["# AI Logs & Analysis report", "## Question", "What happened on pikachu?", "## Analysis", "[dcy-1]", "## Data used", "Records analysed: 3", "pikachu (srv-1)", "Decoy events (2)", "Unavailable sources: System / auth logs", "## Limitations", "Findings list shows 150 of 900"]) {
    assert.ok(md.includes(must), `missing: ${must}`);
  }
});

test("export: print HTML is escaped end to end (question, answer, limitations)", () => {
  const html = buildPrintHtml({ ...report, question: "<img src=x onerror=1>", truncation: ["<script>1</script>"] });
  assert.ok(!/<script|<img/i.test(html));
  assert.ok(html.includes("&lt;img") && html.includes("&lt;script&gt;"));
  assert.ok(html.includes("Data used"));
});

test("export: filenames are sortable and filesystem-safe", () => {
  const f = reportFilename(new Date(NOW), "md");
  assert.match(f, /^ai-analysis-2026-10-18T12-00-00\.md$/);
});
