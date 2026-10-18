import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-LIVE-1: LiveHeartbeatLog must not contain hardcoded EVENT_POOL mock data
test("INV-LIVE-1: LiveHeartbeatLog must not use hardcoded EVENT_POOL mock data", () => {
  const content = fs.readFileSync("src/components/LiveHeartbeatLog.tsx", "utf8");
  assert.ok(
    !content.includes("EVENT_POOL"),
    "LiveHeartbeatLog must not define or use a static EVENT_POOL array"
  );
  assert.ok(
    !content.includes("Honeyfile /etc/shadow.bak checked"),
    "LiveHeartbeatLog must not contain hardcoded fake event messages"
  );
});

// INV-LIVE-2: LiveHeartbeatLog must consume live backend telemetry or SSE
test("INV-LIVE-2: LiveHeartbeatLog must integrate with live backend services", () => {
  const content = fs.readFileSync("src/components/LiveHeartbeatLog.tsx", "utf8");
  assert.ok(
    content.includes("nodeService") || content.includes("dashboardService"),
    "LiveHeartbeatLog must import and query live telemetry services (nodeService or dashboardService)"
  );
});

// INV-LIVE-3: LiveHeartbeatLog must dynamically reflect stream / connection health
test("INV-LIVE-3: LiveHeartbeatLog must dynamically reflect live connection state", () => {
  const content = fs.readFileSync("src/components/LiveHeartbeatLog.tsx", "utf8");
  assert.ok(
    content.includes("connected") || content.includes("isLive"),
    "LiveHeartbeatLog must track live connection state dynamically"
  );
  assert.ok(
    content.includes("DISCONNECTED") || content.includes("OFFLINE") || content.includes("CONNECTING"),
    "LiveHeartbeatLog must support disconnected/offline state indicator"
  );
});

// INV-LIVE-4: LiveHeartbeatLog must enrich global feed with per-node pulses and avoid repetitive sync spam
test("INV-LIVE-4: LiveHeartbeatLog must de-duplicate sync spam and emit per-node pulses in global feed", () => {
  const content = fs.readFileSync("src/components/LiveHeartbeatLog.tsx", "utf8");
  assert.ok(
    content.includes("getAlerts") || content.includes("getAuditLogs"),
    "Global feed must enrich events from getAlerts or getAuditLogs"
  );
  assert.ok(
    content.includes("lastSyncRef") || content.includes("lastGlobalSyncRef") || content.includes("lastNodeStatesRef"),
    "LiveHeartbeatLog must track state refs to prevent identical repetitive spam"
  );
});

// INV-LIVE-5: LiveHeartbeatLog must strictly verify against nodes telemetry and never fabricate pulse ticks
test("INV-LIVE-5: LiveHeartbeatLog must require telemetryMatch and eliminate fake isPulseTick ticks", () => {
  const content = fs.readFileSync("src/components/LiveHeartbeatLog.tsx", "utf8");
  assert.ok(
    !content.includes("isPulseTick"),
    "LiveHeartbeatLog must not contain synthetic isPulseTick pulse generator"
  );
  assert.ok(
    content.includes("telemetryMatch"),
    "LiveHeartbeatLog must require an active telemetryMatch from nodes telemetry before acknowledging heartbeats"
  );
});


