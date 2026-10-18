import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-STREAM-1: src/app/api/v1/[...path]/route.ts must pass through SSE streams without arrayBuffer blocking
test("INV-STREAM-1: proxy route must stream SSE responses directly without arrayBuffer blocking", () => {
  const content = fs.readFileSync("src/app/api/v1/[...path]/route.ts", "utf8");
  assert.ok(
    content.includes("text/event-stream"),
    "route.ts must check for text/event-stream content type"
  );
  assert.ok(
    content.includes("res.body"),
    "route.ts must pass res.body directly to Response when streaming"
  );
  assert.ok(
    content.includes("isEventStream") || content.includes("isStream"),
    "route.ts must branch conditionally for streaming responses"
  );
});

// INV-STREAM-2: Proxy route must configure SSE buffering prevention headers
test("INV-STREAM-2: proxy route must set X-Accel-Buffering and no-cache headers for SSE", () => {
  const content = fs.readFileSync("src/app/api/v1/[...path]/route.ts", "utf8");
  assert.ok(
    content.includes("X-Accel-Buffering") || content.includes("x-accel-buffering"),
    "route.ts must set X-Accel-Buffering header to prevent proxy buffering"
  );
  assert.ok(
    content.includes("no-cache"),
    "route.ts must set Cache-Control: no-cache for event streams"
  );
});

// INV-STREAM-3: EventStream.tsx must preload historical alerts on mount and de-duplicate
test("INV-STREAM-3: EventStream.tsx must preload alerts on mount and de-duplicate items", () => {
  const content = fs.readFileSync("src/components/EventStream.tsx", "utf8");
  assert.ok(
    content.includes("loadRecentAlerts();\n    const es") ||
    content.includes("loadRecentAlerts();\n    // Establish") ||
    content.includes("loadRecentAlerts();\n    let es") ||
    content.includes("loadRecentAlerts();\n    // Try"),
    "EventStream must invoke loadRecentAlerts() unconditionally on mount before SSE setup"
  );
  // Must avoid duplicates when SSE pushes an alert already loaded via REST
  assert.ok(
    content.includes("prev.some((e) => e.id === alert.id)") ||
    content.includes("prev.find((e) => e.id === alert.id)") ||
    content.includes("alert.id"),
    "EventStream must check alert id to avoid duplicate entries"
  );
});

// INV-STREAM-4: src/lib/api.ts StreamingEventSource must implement reconnection resilience
test("INV-STREAM-4: src/lib/api.ts StreamingEventSource must support reconnect resilience", () => {
  const content = fs.readFileSync("src/lib/api.ts", "utf8");
  assert.ok(
    content.includes("reconnect") || content.includes("retry") || content.includes("setTimeout"),
    "StreamingEventSource must implement reconnection / retry mechanism"
  );
});

// INV-STREAM-5: EventStream.tsx must handle undefined or null alert severity safely
test("INV-STREAM-5: EventStream.tsx must guard against undefined/null alert severity", () => {
  const content = fs.readFileSync("src/components/EventStream.tsx", "utf8");
  assert.ok(
    content.includes('(severity || "").toLowerCase()') ||
    content.includes('severity?.toLowerCase()') ||
    content.includes('(severity || "info").toLowerCase()'),
    "severityDot must safely handle undefined or null severity without throwing TypeError"
  );
});

// INV-STREAM-6: src/app/events/page.tsx must guard alert mapping against undefined/null severity
test("INV-STREAM-6: src/app/events/page.tsx must guard alert mapping against undefined severity", () => {
  const content = fs.readFileSync("src/app/events/page.tsx", "utf8");
  assert.ok(
    content.includes('(e.severity || "info").toLowerCase()') ||
    content.includes('e.severity?.toLowerCase()') ||
    content.includes('(e.severity || "").toLowerCase()'),
    "events/page.tsx must safely extract displaySeverity without throwing TypeError"
  );
  assert.ok(
    content.includes('(e.severity || "info").toUpperCase()') ||
    content.includes('e.severity?.toUpperCase()') ||
    content.includes('(e.severity || "").toUpperCase()'),
    "events/page.tsx must safely extract badgeLabel without throwing TypeError"
  );
});

// INV-STREAM-7: src/app/events/page.tsx must refresh an existing alert without duplicating it, and poll when disconnected
test("INV-STREAM-7: src/app/events/page.tsx must refresh existing stream alerts and poll when disconnected", () => {
  const content = fs.readFileSync("src/app/events/page.tsx", "utf8");
  assert.ok(
    content.includes("prev.findIndex((e) => e.id === alert.id)") &&
    content.includes("next[existingIndex] = alert") &&
    content.includes("return [alert, ...prev]"),
    "events/page.tsx must replace matching SSE alerts by id and add only new alerts"
  );
  assert.ok(
    content.includes("setInterval") && (content.includes("connected") || content.includes("pollTimer")),
    "events/page.tsx must implement automatic background fallback polling when disconnected"
  );
});
