import { z } from "zod";

const text = z.string().trim().min(1).max(1000);
const id = z.string().trim().min(1).max(160);
export const timestampSchema = z.string().datetime({ offset: true });
const pid = z.number().int().positive().max(4_194_304);
const base = { id, sourceField: id, sensor: id, timestamp: timestampSchema, severity: z.enum(["critical", "high", "medium", "low"]) };
export const incidentSignalSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("hash_mismatch"), path: text, expectedHash: id, actualHash: id }).refine(s => s.expectedHash !== s.actualHash),
  z.object({ ...base, kind: z.literal("ledger_write"), path: text, pid, authorized: z.literal(false) }),
  z.object({ ...base, kind: z.literal("replica_divergence"), path: text, matchingPeers: z.number().int().nonnegative(), totalPeers: z.number().int().positive() }).refine(s => s.matchingPeers < s.totalPeers),
  z.object({ ...base, kind: z.literal("canary_access"), tokenName: id, pid, path: text }),
  z.object({ ...base, kind: z.literal("credential_file_read"), path: text, pid, credentialKind: z.enum(["shadow", "config"]) }),
  z.object({ ...base, kind: z.literal("agent_killed"), pid, actorPid: pid, signal: z.literal("SIGKILL") }),
  z.object({ ...base, kind: z.literal("agent_disabled"), service: id, enabled: z.literal(false) }),
  z.object({ ...base, kind: z.literal("heartbeat_gap"), gapSeconds: z.number().positive().max(604800), thresholdSeconds: z.number().positive().max(86400), lastSeenAt: timestampSchema }).refine(s => s.gapSeconds > s.thresholdSeconds),
  z.object({ ...base, kind: z.literal("memory_write"), pid, targetPid: pid, bytes: z.number().int().positive() }).refine(s => s.pid !== s.targetPid),
  z.object({ ...base, kind: z.literal("remote_thread"), pid, targetPid: pid }).refine(s => s.pid !== s.targetPid),
  z.object({ ...base, kind: z.literal("executable_private_memory"), pid, bytes: z.number().int().positive() }),
]);
export type IncidentSignal = z.infer<typeof incidentSignalSchema>;

export const telemetryEventSchema = z.object({
  id, timestamp: timestampSchema, event: text, source: id,
  category: z.enum(["baseline", "inbound", "trigger", "response"]),
});
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export const evidenceItemSchema = z.object({ ...base, description: z.string().min(1).max(2400) });
export const attackMappingItemSchema = z.object({
  tactic: id, techniqueId: z.string().regex(/^T\d{4}(?:\.\d{3})?$/), techniqueName: id,
  url: z.string().regex(/^https:\/\/attack\.mitre\.org\/techniques\/T\d{4}\/(?:\d{3}\/)?$/),
  confidence: z.enum(["High", "Medium", "Low"]),
  independentSignals: z.number().int().min(1).max(32),
  evidenceIds: z.array(id).min(1).max(64), matchedReason: z.string().min(1).max(5000),
});
export const blastRadiusSchema = z.object({
  sharedCluster: id.optional(), sharedVpc: id.optional(), sharedFacility: id.optional(), sharedCountry: id.optional(),
  neighbours: z.array(z.object({
    id, name: id, ip: id.optional(), relationships: z.array(z.enum(["Cluster", "VPC", "Facility", "Country"])).min(1),
    status: z.enum(["healthy", "warning", "tampered", "offline"]), isolated: z.boolean(),
  })).max(1000),
});
export const recommendedActionSchema = z.object({
  id, action: id, description: text, priority: z.enum(["Immediate", "High", "Medium", "Routine"]),
  isAppAction: z.boolean(), appActionType: z.literal("isolate_node").optional(), completed: z.boolean(),
});
export const timelineItemSchema = telemetryEventSchema.extend({ relativeTime: id });
export const incidentBriefSchema = z.object({
  id, engine: z.enum(["rules", "llm"]), nodeId: id, nodeName: id, nodeIp: id.optional(),
  alertType: id, generatedAt: timestampSchema.optional(), detectedAt: timestampSchema.optional(),
  isolated: z.boolean(), summary: z.string().min(1).max(5000),
  evidence: z.array(evidenceItemSchema).max(64), attackMapping: z.array(attackMappingItemSchema).max(8),
  unmappedReason: text.optional(), likelyIntent: text.optional(), blastRadius: blastRadiusSchema.optional(),
  recommendedActions: z.array(recommendedActionSchema).max(12), timeline: z.array(timelineItemSchema).max(8),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
export type AttackMappingItem = z.infer<typeof attackMappingItemSchema>;
export type BlastRadius = z.infer<typeof blastRadiusSchema>;
export type RecommendedAction = z.infer<typeof recommendedActionSchema>;
export type TimelineItem = z.infer<typeof timelineItemSchema>;
export type IncidentBrief = z.infer<typeof incidentBriefSchema>;

const mdText = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/[\\\x60*_{}[\]<>|]/g, "\\$&");

/** Plain text only; no HTML rendering, secret values, or automatic actions. */
export function formatBriefAsMarkdown(brief: IncidentBrief, checked: Record<string, boolean> = {}): string {
  const lines = [
    "# AI Incident Brief — " + mdText(brief.nodeName),
    "**Rules engine** · " + mdText(brief.alertType) + (brief.nodeIp ? " · " + mdText(brief.nodeIp) : ""),
    ...(brief.generatedAt ? ["**Telemetry snapshot:** " + brief.generatedAt] : []),
    "", "## 1. Summary", mdText(brief.summary),
  ];
  if (brief.evidence.length) {
    lines.push("", "## 2. Evidence (facts)");
    brief.evidence.forEach(e => lines.push("- " + mdText(e.description) + " — Source: " + mdText(e.sourceField) + " · " + e.timestamp));
  }
  lines.push("", "## 3. ATT&CK mapping");
  brief.attackMapping.forEach(m => lines.push(
    "- [" + m.techniqueId + " — " + mdText(m.techniqueName) + "](" + m.url + ") · " + mdText(m.tactic),
    "  - Confidence: " + m.confidence + " (" + m.independentSignals + " independent matching sensors)",
    "  - Matched because " + mdText(m.matchedReason),
  ));
  if (brief.unmappedReason) lines.push("Unmapped — " + mdText(brief.unmappedReason));
  if (brief.likelyIntent) lines.push("", "## 4. Likely intent", "> Analysis (inference): " + mdText(brief.likelyIntent));
  if (brief.blastRadius) {
    lines.push("", "## 5. Blast radius", "Shared infrastructure indicates potential exposure, not confirmed compromise.");
    const b = brief.blastRadius;
    for (const [label, value] of [["Cluster", b.sharedCluster], ["VPC", b.sharedVpc], ["Facility", b.sharedFacility], ["Country", b.sharedCountry]]) {
      if (value) lines.push("- " + label + ": " + mdText(value));
    }
    b.neighbours.forEach(n => lines.push("- " + mdText(n.name) + " — " + n.relationships.join(", ") + " · " + (n.isolated ? "Isolated" : n.status)));
    if (!b.neighbours.length) lines.push("No other nodes share the known boundaries in the supplied inventory.");
  }
  if (brief.recommendedActions.length) {
    lines.push("", "## 6. Recommended actions", "Analyst checklist; no action is executed automatically.");
    brief.recommendedActions.forEach((a, i) => lines.push(
      (i + 1) + ". [" + ((a.isAppAction ? a.completed : checked[a.id]) ? "x" : " ") + "] " + mdText(a.action) + " (" + a.priority + "): " + mdText(a.description)
    ));
  }
  if (brief.timeline.length) {
    lines.push("", "## 7. Timeline");
    brief.timeline.forEach(e => lines.push("- " + e.timestamp + " (" + e.relativeTime + ") · " + mdText(e.event) + " — " + mdText(e.source)));
  }
  return lines.join("\n");
}
