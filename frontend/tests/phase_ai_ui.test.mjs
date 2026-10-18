import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROLE_PERMISSIONS } from "../src/lib/types.ts";

const read = (p) => fs.readFileSync(p, "utf8");
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const uiFiles = [
  ...walk("src/components/ai-analysis"),
  "src/lib/markdown.ts",
  "src/lib/aiExport.ts",
  "src/app/ai-analysis/page.tsx",
  "src/services/aiAnalysisService.ts",
];

// INV-AI-UI-1: model output is untrusted; it must never reach the DOM as raw HTML
test("INV-AI-UI-1: no raw-HTML sinks anywhere in the AI UI code", () => {
  for (const f of uiFiles) {
    const src = read(f);
    for (const sink of ["dangerouslySetInnerHTML", "innerHTML", "outerHTML", "insertAdjacentHTML", "eval(", "new Function"]) {
      assert.ok(!src.includes(sink), `${f} uses ${sink}`);
    }
  }
});

// INV-AI-UI-2: the bearer token only ever travels in a header
test("INV-AI-UI-2: the AI service sends the token in Authorization only, never in a URL, and never to localStorage", () => {
  const svc = read("src/services/aiAnalysisService.ts");
  assert.ok(/Authorization:\s*`Bearer \$\{token\}`/.test(svc), "must use the Authorization header");
  assert.ok(!/[?&]token=/.test(svc), "no token query parameter");
  assert.ok(!svc.includes("localStorage"), "service does not touch storage itself");
  assert.ok(svc.includes('method: "POST"'), "uses POST streaming");
  assert.ok(svc.includes("/api/ai-analysis/"), "talks to the dedicated endpoints");
});

// INV-AI-UI-3: permission matrix
test("INV-AI-UI-3: only admin roles hold ai.analyze (platform_owner via wildcard, tenant-admin explicitly)", () => {
  assert.deepEqual(ROLE_PERMISSIONS.platform_owner, ["*"]);
  assert.ok(ROLE_PERMISSIONS["tenant-admin"].includes("ai.analyze"));
  assert.ok(!ROLE_PERMISSIONS["security-analyst"].includes("ai.analyze"));
  assert.ok(!ROLE_PERMISSIONS["read-only"].includes("ai.analyze"));
});

test("INV-AI-UI-3: the page, the nav entry and the server guard all check the same permission", () => {
  assert.ok(read("src/app/ai-analysis/page.tsx").includes('can("ai.analyze")'), "page gate");
  const side = read("src/components/Sidebar.tsx");
  assert.ok(side.includes('href: "/ai-analysis"') && side.includes('permission: "ai.analyze"'), "nav entry is permission-gated");
  assert.ok(read("src/lib/ai/guard.ts").includes('"ai.analyze"'), "server guard uses the same permission name");
});

// INV-AI-UI-4: endpoints
test("INV-AI-UI-4: routes expose POST only, are never cached, and delegate to the tested handlers", () => {
  for (const [file, fn] of [
    ["src/app/api/ai-analysis/query/route.ts", "query"],
    ["src/app/api/ai-analysis/followup/route.ts", "followup"],
  ]) {
    const src = read(file);
    assert.ok(/export async function POST\(/.test(src));
    for (const verb of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) assert.ok(!new RegExp(`export (async )?function ${verb}\\b`).test(src), `${file} exports ${verb}`);
    assert.ok(src.includes('dynamic = "force-dynamic"'));
    assert.ok(src.includes('runtime = "nodejs"'));
    assert.ok(src.includes(`getAiHandlers().${fn}(request)`));
    assert.ok(src.split("\n").length < 15, "routes stay thin; logic lives in src/lib/ai");
  }
});

test("INV-AI-UI-4: nothing on the server can write: no mutating verbs or backend writes in src/lib/ai", () => {
  for (const f of walk("src/lib/ai")) {
    const src = read(f);
    assert.ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(src) || f.endsWith("provider.ts"), `${f} issues a write request`);
  }
  const backend = read("src/lib/ai/backend.ts");
  assert.ok(backend.includes('method: "GET"') && !/POST|PUT|PATCH|DELETE/.test(backend));
});

// maintainability: server library is framework-free and testable
test("server library has no framework or alias imports and never runs in the browser", () => {
  for (const f of walk("src/lib/ai")) {
    const src = read(f);
    assert.ok(!src.includes('"@/'), `${f} uses a path alias`);
    assert.ok(!src.includes("use client"), `${f} is marked as a client module`);
    assert.ok(!/from "next\//.test(src), `${f} depends on next`);
  }
});

// UX states required by the brief
test("UX: loading, empty and error states exist for servers and conversation", () => {
  const sel = read("src/components/ai-analysis/ServerMultiSelect.tsx");
  assert.ok(sel.includes("Loading servers"), "servers loading state");
  assert.ok(sel.includes("No servers are registered"), "servers empty state");
  assert.ok(sel.includes("Could not load servers") && sel.includes("Retry"), "servers error + retry");
  const chat = read("src/components/ai-analysis/ChatPanel.tsx");
  assert.ok(chat.includes("PROMPT_CHIPS"), "suggested prompt chips");
  assert.ok(chat.includes("Stop generating"), "stop streaming");
  assert.ok(chat.includes("Ask about your decoys and logs"), "empty state");
  const msg = read("src/components/ai-analysis/MessageBubble.tsx");
  for (const must of ["Collecting data", "Analysing", "Retry", "DataUsedBar", "Copy", "Markdown", "PDF", 'role="alert"']) assert.ok(msg.includes(must), `MessageBubble missing ${must}`);
});

test("UX: the answer is rendered in the five required sections with Data used underneath", () => {
  const prompt = read("src/lib/ai/prompt.ts");
  for (const h of ["## Summary", "## Timeline", "## Affected assets", "## Risk assessment", "## Recommended actions"]) assert.ok(prompt.includes(h), h);
  const md = read("src/components/ai-analysis/SafeMarkdown.tsx");
  for (const icon of ["Clock", "Server", "ShieldAlert", "ListChecks", "FileText"]) assert.ok(md.includes(icon), `section icon ${icon}`);
  assert.ok(read("src/components/ai-analysis/DataUsedBar.tsx").includes("Data used"));
});

test("a11y: interactive controls are labelled and the server picker is a proper listbox", () => {
  const sel = read("src/components/ai-analysis/ServerMultiSelect.tsx");
  for (const must of ['role="listbox"', 'aria-multiselectable="true"', 'role="option"', "aria-selected", "aria-expanded", "ArrowDown", "Escape"]) assert.ok(sel.includes(must), `ServerMultiSelect missing ${must}`);
  const chat = read("src/components/ai-analysis/ChatPanel.tsx");
  assert.ok(chat.includes('aria-label="Your question"') && chat.includes('aria-label="Send question"'));
});
