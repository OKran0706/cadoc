import {
  incidentBriefSchema, incidentSignalSchema, telemetryEventSchema, timestampSchema,
  type IncidentBrief, type IncidentSignal, type BlastRadius, type EvidenceItem,
} from "./incidentBrief";
import { ALERT_RULES_DATABASE, type SeededAlertType } from "./incidentRules";
import type { TopologyNode, NodeIncident } from "./holisticData";

export interface IncidentContext { allNodes?: TopologyNode[]; now?: Date; engine?: "rules" | "llm" }
export function hasActiveIncident(node: TopologyNode): boolean {
  if (node.isolatedAt || node.incident?.state === "contained" || node.incident?.state === "resolved") return false;
  return Boolean(node.incident || node.tampered || node.threats > 0 || node.status === "warning");
}
function stamp(value: unknown): string | undefined {
  const result = timestampSchema.safeParse(value);
  return result.success ? new Date(result.data).toISOString() : undefined;
}
function clean(value: unknown, max = 160): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}
export function formatIncidentTime(timestamp: string, timezone?: string): string {
  const iso = stamp(timestamp);
  if (!iso) return "";
  const utc = iso.replace("T", " ").slice(0, 19) + " UTC";
  if (!timezone) return utc;
  try {
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(new Date(iso));
    return local + " (" + timezone + " site-local); " + utc;
  } catch { return utc; }
}
function describe(s: IncidentSignal): string {
  switch(s.kind) {
    case "hash_mismatch": return "Hash mismatch on " + s.path + ": expected " + s.expectedHash + ", observed " + s.actualHash + ".";
    case "ledger_write": return "PID " + s.pid + " wrote " + s.path + " outside the authorized writer policy.";
    case "replica_divergence": return s.matchingPeers + " of " + s.totalPeers + " peer checksums matched " + s.path + ".";
    case "canary_access": return "PID " + s.pid + " accessed honeytoken " + s.tokenName + " in " + s.path + ".";
    case "credential_file_read": return "PID " + s.pid + " read credential file " + s.path + ".";
    case "agent_killed": return "PID " + s.actorPid + " sent " + s.signal + " to security agent PID " + s.pid + ".";
    case "agent_disabled": return "Security service " + s.service + " was recorded as disabled.";
    case "heartbeat_gap": return "Heartbeat gap of " + s.gapSeconds + " seconds exceeded the " + s.thresholdSeconds + "-second threshold; last received " + s.lastSeenAt + ".";
    case "memory_write": return "PID " + s.pid + " wrote " + s.bytes + " bytes into PID " + s.targetPid + ".";
    case "remote_thread": return "PID " + s.pid + " started a thread in PID " + s.targetPid + ".";
    case "executable_private_memory": return "PID " + s.pid + " contained a " + s.bytes + "-byte private executable memory region.";
  }
}
function buildLocationString(node: TopologyNode): string {
  return [node.geo?.city, node.geo?.country, node.facility?.name,
    node.placement?.floorName?.split(":")[0] ?? (typeof node.placement?.floor === "number" ? "Floor " + node.placement.floor : undefined),
    node.placement?.rack, node.placement?.unit].map(v => clean(v)).filter(Boolean).join(", ");
}
function computeBlastRadius(node: TopologyNode, allNodes: TopologyNode[]): BlastRadius | undefined {
  const info = {
    sharedCluster: clean(node.cluster), sharedVpc: clean(node.vpcId),
    sharedFacility: clean(node.facility?.name), sharedCountry: clean(node.geo?.country),
  };
  if (!Object.values(info).some(Boolean)) return undefined;
  const seen = new Set<string>([node.id]);
  const neighbours: BlastRadius["neighbours"] = [];
  for (const peer of allNodes.slice(0, 1000)) {
    if (seen.has(peer.id) || !node.tenantId || peer.tenantId !== node.tenantId) continue;
    seen.add(peer.id);
    const relationships: BlastRadius["neighbours"][number]["relationships"] = [];
    if (node.cluster && peer.cluster === node.cluster) relationships.push("Cluster");
    if (node.vpcId && peer.vpcId === node.vpcId) relationships.push("VPC");
    if (node.facility?.id && peer.facility?.id === node.facility.id) relationships.push("Facility");
    if (node.geo?.countryCode && peer.geo?.countryCode === node.geo.countryCode) relationships.push("Country");
    if (relationships.length) neighbours.push({
      id: peer.id, name: clean(peer.name) ?? peer.id, ip: clean(peer.ip), relationships, status: peer.status, isolated: Boolean(peer.isolatedAt),
    });
  }
  return { ...info, neighbours };
}

/** Deterministic, offline analysis. No clock, random IDs, network, React, or executable response. */
export function explainIncident(node: TopologyNode, incident: NodeIncident | null | undefined = node.incident, context: IncidentContext = {}): IncidentBrief | null {
  if (!node || !clean(node.id) || !clean(node.name)) return null;
  if (incident?.nodeId && incident.nodeId !== node.id) return null;
  if (incident?.state === "resolved") return null;
  if (!hasActiveIncident({ ...node, incident: incident ?? undefined }) && !node.isolatedAt) return null;
  const type: SeededAlertType = incident?.alertType && Object.hasOwn(ALERT_RULES_DATABASE, incident.alertType) ? incident.alertType : "unmapped";
  const rule = ALERT_RULES_DATABASE[type];
  const detectedAt = stamp(incident?.detectedAt);
  const generatedAt = stamp(context.now?.toISOString()) ?? stamp(incident?.observedAt) ?? detectedAt;
  const signals: IncidentSignal[] = [];
  const ids = new Set<string>();
  for (const input of (Array.isArray(incident?.signals) ? incident.signals : []).slice(0,64)) {
    const parsed = incidentSignalSchema.safeParse(input);
    if (!parsed.success || ids.has(parsed.data.id)) continue;
    ids.add(parsed.data.id);
    signals.push(parsed.data);
  }
  const evidence: EvidenceItem[] = signals.map(s => ({
    id: s.id, sourceField: s.sourceField, sensor: s.sensor, timestamp: s.timestamp, severity: s.severity, description: describe(s),
  }));
  const attackMapping = rule.mitreMappings.filter(m => m.required(signals)).flatMap(m => {
    const matched = signals.filter(s => m.matches(s, signals));
    const independentSignals = new Set(matched.map(s => s.sensor)).size;
    if (!independentSignals) return [];
    return [{
      tactic: m.tactic, techniqueId: m.techniqueId, techniqueName: m.techniqueName, url: m.url,
      confidence: independentSignals >= 3 ? "High" as const : independentSignals === 2 ? "Medium" as const : "Low" as const,
      independentSignals, evidenceIds: matched.map(s => s.id), matchedReason: matched.map(describe).join(" "),
    }];
  });
  const location = buildLocationString(node);
  const summary = [
    node.name + (node.ip ? " (" + node.ip + ")" : "") + " reported " + rule.name.toLowerCase() + (location ? " at " + location : "") + ".",
    evidence.length ? evidence[0].description : "Detailed telemetry is not available in this incident record.",
    detectedAt ? "The alert was detected at " + formatIncidentTime(detectedAt, node.geo?.timezone) + "." : "",
  ].filter(Boolean).join(" ");
  const eventIds = new Set<string>();
  const events = (Array.isArray(incident?.events) ? incident.events : []).slice(0,256).flatMap(input => {
    const parsed = telemetryEventSchema.safeParse(input);
    if (!parsed.success || eventIds.has(parsed.data.id)) return [];
    eventIds.add(parsed.data.id);
    return [parsed.data];
  }).sort((a,b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const before = detectedAt ? events.filter(e => e.timestamp < detectedAt).slice(-3) : [];
  const after = detectedAt ? events.filter(e => e.timestamp >= detectedAt).slice(0,8-before.length) : events.slice(-8);
  const timeline = [...before,...after].map(e => {
    const seconds = detectedAt ? Math.round((Date.parse(e.timestamp) - Date.parse(detectedAt))/1000) : undefined;
    const relativeTime = seconds === undefined ? "Recorded event" : seconds === 0 ? "Alert" : Math.abs(seconds) + "s " + (seconds < 0 ? "before alert" : "after alert");
    return { ...e, relativeTime };
  });
  const result = incidentBriefSchema.safeParse({
    id: "brief-" + (clean(incident?.id) ?? node.id), engine: "rules", nodeId: node.id, nodeName: node.name, nodeIp: clean(node.ip),
    alertType: rule.name, generatedAt, detectedAt, isolated: Boolean(node.isolatedAt), summary, evidence, attackMapping,
    unmappedReason: attackMapping.length ? undefined : rule.unmappedReason,
    likelyIntent: evidence.length && rule.intentAnalysis ? rule.intentAnalysis : undefined,
    blastRadius: computeBlastRadius(node, context.allNodes ?? []),
    recommendedActions: rule.baseActions.map(a => ({...a, completed: a.isAppAction && Boolean(node.isolatedAt)})), timeline,
  });
  return result.success ? result.data : null;
}
