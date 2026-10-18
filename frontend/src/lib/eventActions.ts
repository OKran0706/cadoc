import type { AlertPayload, DecoyResponse } from "./types";

export function isTamperedDecoyAlert(alert: AlertPayload, decoy?: Pick<DecoyResponse, "id" | "file_path" | "status"> | null): boolean {
  const eventType = (alert.event_type || "").toLowerCase();
  if (/(decoy|canary|honeytoken)/.test(eventType) && /(tamper|trip|trigger|breach|compromis)/.test(eventType)) {
    return true;
  }

  const details = alert.details || {};
  const decoyId = [details.decoy_id, details.decoyId, details.asset_id].find(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  const filePath = [details.file_path, details.path].find(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  if (!decoyId && !filePath) return false;

  if (typeof details.decoy_status === "string" && details.decoy_status.toLowerCase() === "tampered") {
    return true;
  }

  const matchesDecoy = decoy && (
    (decoyId && decoy.id === decoyId) || (filePath && decoy.file_path === filePath)
  );
  return Boolean(matchesDecoy && decoy.status.toLowerCase() === "tampered");
}

export function getQuarantineKillParent(alert: AlertPayload, decoy?: Pick<DecoyResponse, "id" | "file_path" | "status"> | null): boolean | null {
  const eventType = (alert.event_type || "").toLowerCase().replace(/[.\s-]+/g, "_");
  if (/^(server|agent)_(added|readded|registered|created|onboarded)$/.test(eventType)) return null;
  const status = (alert.status || "OPEN").toUpperCase();
  if (status !== "OPEN" && status !== "QUARANTINE_FAILED") return null;
  if (/(^|_)tamper(ed|ing)?(_|$)/.test(eventType) || isTamperedDecoyAlert(alert, decoy)) return true;

  const severe = ["high", "critical", "severe", "dangerous"].includes((alert.severity || "").toLowerCase());
  const dangerousType = /(^|_)(malware|ransomware|intrusion|breach|compromise|compromised|exploit|attack|threat|dangerous|suspicious|unauthorized)(_|$)/.test(eventType);
  if (!severe && !dangerousType) return null;

  const details = alert.details || {};
  const decoyId = [details.decoy_id, details.decoyId, details.asset_id].find((value) => typeof value === "string" && value.length > 0);
  const filePath = [details.file_path, details.path].find((value) => typeof value === "string" && value.length > 0);
  const matchesDecoy = decoy && ((decoyId && decoy.id === decoyId) || (filePath && decoy.file_path === filePath));
  if ((decoyId || filePath) && !matchesDecoy && typeof details.decoy_status !== "string") return null;
  return false;
}

export function getQuarantineDisplayStatus(alert: AlertPayload, requestedLocally: boolean): "requested" | "completed" | null {
  const status = (alert.status || "").toUpperCase();
  if (status === "QUARANTINED") return "completed";
  if (status === "QUARANTINE_REQUESTED") return "requested";
  if (status && status !== "OPEN") return null;
  return requestedLocally ? "requested" : null;
}
