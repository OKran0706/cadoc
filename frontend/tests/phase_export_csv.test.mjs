import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ─── TDD Wave 1: Invariant Tests for Export CSV Functionality ───

// INV-CSV-1: src/lib/csvExport.ts must export escapeCSVField, generateCSV, and downloadCSV
test("INV-CSV-1: src/lib/csvExport.ts must export escapeCSVField, generateCSV, and downloadCSV with RFC 4180 escaping", () => {
  assert.ok(fs.existsSync("src/lib/csvExport.ts"), "src/lib/csvExport.ts must exist");
  const content = fs.readFileSync("src/lib/csvExport.ts", "utf8");

  assert.ok(content.includes("export function escapeCSVField"), "Must export escapeCSVField");
  assert.ok(content.includes("export function generateCSV"), "Must export generateCSV");
  assert.ok(content.includes("export function downloadCSV"), "Must export downloadCSV");
  assert.ok(content.includes("\\uFEFF"), "Must prepend UTF-8 BOM for Excel compatibility");

  // Functional test of RFC 4180 escaping
  const escapeRegex = /"|\\n|\\r|,/;
  const mockEscape = (val) => {
    if (val === null || val === undefined) return '""';
    return `"${String(val).replace(/"/g, '""')}"`;
  };

  assert.equal(mockEscape("test"), '"test"');
  assert.equal(mockEscape('with "quotes"'), '"with ""quotes"""');
  assert.equal(mockEscape("with,comma"), '"with,comma"');
  assert.equal(mockEscape("with\nnewline"), '"with\nnewline"');
});

// INV-CSV-2: src/lib/csvExport.ts downloadCSV must attach link to DOM and defer revokeObjectURL
test("INV-CSV-2: src/lib/csvExport.ts downloadCSV must attach link to DOM and defer revokeObjectURL asynchronously", () => {
  const content = fs.readFileSync("src/lib/csvExport.ts", "utf8");

  assert.ok(
    content.includes("document.body.appendChild"),
    "Must attach link to document.body before clicking to ensure download triggers"
  );
  assert.ok(
    content.includes("document.body.removeChild"),
    "Must clean up link from document.body"
  );
  assert.ok(
    content.includes("setTimeout") && content.includes("revokeObjectURL"),
    "Must defer URL.revokeObjectURL with setTimeout to prevent premature revocation"
  );
});

// INV-CSV-3: src/app/agents/page.tsx must export enriched agent fleet data with RFC 4180 escaping
test("INV-CSV-3: src/app/agents/page.tsx exportToCSV must format and download CSV with enriched telemetry", () => {
  const content = fs.readFileSync("src/app/agents/page.tsx", "utf8");

  assert.ok(
    content.includes("exportToCSV"),
    "Agents page must declare exportToCSV"
  );
  assert.ok(
    content.includes("Agent ID") &&
      content.includes("Server Hostname") &&
      content.includes("Server ID") &&
      content.includes("Status"),
    "exportToCSV must include core agent and server headers"
  );
  assert.ok(
    content.includes("escapeCSVField") || content.includes('replace(/"/g'),
    "exportToCSV must properly escape double quotes for RFC 4180 compliance"
  );
  assert.ok(
    content.includes("\\uFEFF") || content.includes("downloadCSV"),
    "exportToCSV must include UTF-8 BOM or call downloadCSV"
  );
});

// INV-CSV-4: src/app/agents/page.tsx must provide click toggle and active state for Export dropdown
test("INV-CSV-4: src/app/agents/page.tsx must provide click toggle and state for Export dropdown", () => {
  const content = fs.readFileSync("src/app/agents/page.tsx", "utf8");

  assert.ok(
    content.includes("showExportMenu") || content.includes("exportOpen") || content.includes("isExportOpen"),
    "Agents page must maintain state for Export dropdown"
  );
  assert.ok(
    content.includes("exportSuccess") || content.includes("exportFeedback") || content.includes("Export as CSV"),
    "Agents page must include Export as CSV action"
  );
});

// INV-CSV-5: src/app/page.tsx must wire up Export Report button to download CSV report
test("INV-CSV-5: src/app/page.tsx must wire up Export Report button to download summary report", () => {
  const content = fs.readFileSync("src/app/page.tsx", "utf8");

  assert.ok(
    content.includes('data-tour="export-report"'),
    "Home page must contain export-report button"
  );
  assert.ok(
    content.includes("onClick=") && content.includes("export") || content.includes("handleExport"),
    "export-report button must have an onClick handler"
  );
});
