import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { getQuarantineDisplayStatus, getQuarantineKillParent, isTamperedDecoyAlert } from "../src/lib/eventActions.ts";
import { dashboardService } from "../src/services/dashboardService.ts";

const alert = (overrides = {}) => ({
  id: "alert-1",
  server_id: "server-1",
  event_type: "file_changed",
  severity: "critical",
  details: {},
  detected_at: "2026-10-18T10:00:00Z",
  ...overrides,
});

test("INV-1: tampered decoy alerts select Quarantine", () => {
  assert.equal(isTamperedDecoyAlert(alert({ event_type: "decoy_tampered" })), true);
  assert.equal(isTamperedDecoyAlert(alert({ details: { decoy_id: "decoy-1" } }), {
    id: "decoy-1", status: "tampered", file_path: "/tmp/trap",
  }), true);
  assert.equal(isTamperedDecoyAlert(alert({ details: { decoy_id: "decoy-1", decoy_status: "tampered" } })), true);
});

test("INV-2: tamper, dangerous type, or severe alerts qualify; routine server events do not", () => {
  const tamperedDecoy = { id: "decoy-1", status: "tampered", file_path: "/tmp/trap" };
  assert.equal(isTamperedDecoyAlert(alert(), tamperedDecoy), false);
  assert.equal(isTamperedDecoyAlert(alert({ details: { decoy_id: "decoy-2" } }), tamperedDecoy), false);
  assert.equal(isTamperedDecoyAlert(alert({ event_type: "decoy_healthy" })), false);
  assert.equal(getQuarantineKillParent(alert({ event_type: "decoy_tampered", severity: "info" })), true);
  assert.equal(getQuarantineKillParent(alert({ event_type: "FILE_TAMPERED", severity: "low" })), true);
  assert.equal(getQuarantineKillParent(alert({ event_type: "MALWARE_DETECTED", severity: "low" })), false);
  assert.equal(getQuarantineKillParent(alert({ event_type: "threat_detected", severity: "high" })), false);
  assert.equal(getQuarantineKillParent(alert({ event_type: "threat_detected", severity: "critical" })), false);
  assert.equal(getQuarantineKillParent(alert({ event_type: "file_changed", severity: "high", details: { decoy_id: "decoy-1" } })), null);
  assert.equal(getQuarantineKillParent(alert({ event_type: "file_changed", severity: "high", details: { decoy_id: "decoy-1" } }), { id: "decoy-1", file_path: "/tmp/trap", status: "tampered" }), true);
  assert.equal(getQuarantineKillParent(alert({ event_type: "file_changed", severity: "high", details: { decoy_id: "decoy-1" } }), { id: "decoy-1", file_path: "/tmp/trap", status: "planted" }), false);
  assert.equal(getQuarantineKillParent(alert({ event_type: "server_added", severity: "critical" })), null);
  assert.equal(getQuarantineKillParent(alert({
    id: "9e4334e7-89c2-4abe-9273-b6e0088357a7",
    event_type: "SERVER_READDED",
    severity: "low",
    details: { action: "merged", message: "This machine was registered before (previous server re-added)." },
    status: "OPEN",
  })), null);
  assert.equal(getQuarantineKillParent(alert({ event_type: "SERVER_READDED", severity: "high" })), null);
  assert.equal(getQuarantineKillParent(alert({ event_type: "login_failed", severity: "warning" })), null);
  assert.equal(getQuarantineKillParent(alert({ event_type: "threat_detected", severity: "critical", status: "QUARANTINE_REQUESTED" })), null);
});

test("INV-3: quarantine sends the encoded alert ID and selected kill_parent value", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(null, { status: 204 });
  };
  try {
    await dashboardService.quarantineAlert("alert/1", true);
    await dashboardService.quarantineAlert("alert/2", false);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/api\/v1\/dashboard\/alerts\/alert%2F1\/quarantine$/);
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), { kill_parent: true });
    assert.match(calls[1].url, /\/api\/v1\/dashboard\/alerts\/alert%2F2\/quarantine$/);
    assert.deepEqual(JSON.parse(calls[1].options.body), { kill_parent: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("INV-4: queued and completed quarantine states are distinct; failures remain retryable", () => {
  assert.equal(getQuarantineDisplayStatus(alert({ status: "QUARANTINE_REQUESTED" }), false), "requested");
  assert.equal(getQuarantineDisplayStatus(alert({ status: "QUARANTINED" }), false), "completed");
  assert.equal(getQuarantineDisplayStatus(alert({ status: "OPEN" }), true), "requested");
  assert.equal(getQuarantineDisplayStatus(alert({ status: "QUARANTINE_FAILED" }), true), null);
});

test("INV-5: Events page renders Quarantine only for eligible alerts", () => {
  const source = fs.readFileSync("src/app/events/page.tsx", "utf8");
  assert.match(source, /getQuarantineKillParent\(e, decoy\)/);
  assert.match(source, /killParent !== null && !quarantineStatus/);
  assert.match(source, /handleQuarantine\(e\.id, killParent, ev\)/);
  assert.doesNotMatch(source, /Mitigate Threat|handleMitigate\(/);
});
