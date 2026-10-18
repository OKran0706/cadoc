import type { IncidentSignal, RecommendedAction } from "./incidentBrief";

export type SeededAlertType = "ledger_tamper" | "canary_access" | "credential_read" | "agent_disabled" | "heartbeat_lost" | "memory_injection" | "unmapped";
type Action = Omit<RecommendedAction, "completed">;
export interface AttackRule {
  tactic: string; techniqueId: string; techniqueName: string; url: string;
  required: (signals: IncidentSignal[]) => boolean;
  matches: (signal: IncidentSignal, signals: IncidentSignal[]) => boolean;
}
export interface AlertRuleDefinition {
  name: string; intentAnalysis: string; mitreMappings: AttackRule[]; baseActions: Action[]; unmappedReason: string;
}
const isolate: Action = { id: "isolate", action: "Isolate Node from Cluster", description: "Review the impact and confirm quarantine using the existing node control.", priority: "Immediate", isAppAction: true, appActionType: "isolate_node" };
const preserve: Action = { id: "preserve", action: "Preserve forensic snapshot", description: "Preserve the relevant files, process metadata and logs before making further changes.", priority: "High", isAppAction: false };
const review: Action = { id: "review", action: "Review connections to neighbouring nodes", description: "Review access and connection logs for the shared infrastructure shown below. Shared location alone does not prove spread.", priority: "High", isAppAction: false };
const action = (id: string, label: string, description: string): Action => ({ id, action: label, description, priority: "High", isAppAction: false });
const kind = (k: IncidentSignal["kind"]) => (signals: IncidentSignal[]) => signals.some(s => s.kind === k);
const configRead = (s: IncidentSignal) => s.kind === "credential_file_read" && s.credentialKind === "config";
const shadowRead = (s: IncidentSignal) => s.kind === "credential_file_read" && s.credentialKind === "shadow" && ["/etc/passwd", "/etc/shadow"].includes(s.path);
const mapping = (tactic: string, techniqueId: string, techniqueName: string, required: AttackRule["required"], matches: AttackRule["matches"]): AttackRule => ({
  tactic, techniqueId, techniqueName, url: "https://attack.mitre.org/techniques/" + techniqueId.replace(".", "/") + "/", required, matches,
});

// Technique names, IDs and tactics verified on attack.mitre.org, 2026-10-18.
// T1562.001 now resolves to T1685 (Defense Impairment). T1055 lists Stealth / Privilege Escalation.
// A heartbeat gap is not sufficient evidence of T1489 Service Stop.
export const ALERT_RULES_DATABASE: Record<SeededAlertType, AlertRuleDefinition> = {
  ledger_tamper: {
    name: "Ledger / data tampering",
    intentAnalysis: "The changed stored data may indicate an attempt to alter records or their audit trail. A legitimate write or storage fault still needs to be ruled out.",
    mitreMappings: [mapping("Impact", "T1565.001", "Stored Data Manipulation",
      signals => signals.some(s => s.kind === "hash_mismatch" || s.kind === "ledger_write"),
      s => ["hash_mismatch", "ledger_write", "replica_divergence"].includes(s.kind))],
    baseActions: [isolate, preserve, action("verify-ledger", "Compare with a verified ledger copy", "Compare affected files and peer replicas against a trusted checkpoint; preserve the current copy before any recovery."), review],
    unmappedReason: "No validated stored-data modification signal supports a technique.",
  },
  canary_access: {
    name: "Canary / honeytoken access",
    intentAnalysis: "The decoy access may indicate discovery of exposed credentials. It does not establish that a real credential was stolen or used successfully.",
    mitreMappings: [mapping("Credential Access", "T1552.001", "Credentials In Files",
      signals => signals.some(configRead),
      (s, signals) => configRead(s) || (s.kind === "canary_access" && signals.some(other => configRead(other) && other.kind === "credential_file_read" && other.path === s.path && other.pid === s.pid)))],
    baseActions: [isolate, preserve, action("trace-token", "Review the honeytoken access", "Trace the process and token access, then check whether any real secrets were exposed."), review],
    unmappedReason: "A canary touch alone does not identify an ATT&CK technique; credential-file access is not corroborated.",
  },
  credential_read: {
    name: "Credential file read",
    intentAnalysis: "The observed read may be an attempt to collect credentials for later access. Access alone does not establish successful authentication, exploitation, or persistence.",
    mitreMappings: [
      mapping("Credential Access", "T1003.008", "/etc/passwd and /etc/shadow", signals => signals.some(shadowRead), shadowRead),
      mapping("Credential Access", "T1552.001", "Credentials In Files", signals => signals.some(configRead), configRead),
    ],
    baseActions: [isolate, preserve, action("rotate", "Rotate affected credentials after review", "Identify accounts exposed by the observed file access, then revoke or rotate their credentials through the approved procedure."), review],
    unmappedReason: "No validated credential-file read identifies a supported technique.",
  },
  agent_disabled: {
    name: "Security agent killed / disabled",
    intentAnalysis: "Disabling security monitoring may be intended to reduce visibility of subsequent activity. Check approved maintenance and service logs before attributing intent.",
    mitreMappings: [mapping("Defense Impairment", "T1685", "Disable or Modify Tools",
      signals => signals.some(s => s.kind === "agent_killed" || s.kind === "agent_disabled"),
      s => s.kind === "agent_killed" || s.kind === "agent_disabled")],
    baseActions: [isolate, preserve, action("agent-logs", "Review service and process audit logs", "Identify the actor that stopped or disabled the security service and compare against approved maintenance."), action("restore-agent", "Restore security monitoring after review", "After evidence preservation, verify the agent binary and restore monitoring using the approved runbook."), review],
    unmappedReason: "No validated termination or disabling of a security tool was recorded.",
  },
  heartbeat_lost: {
    name: "Heartbeat lost",
    intentAnalysis: "The heartbeat gap may reflect a network outage, a failed host or an interrupted agent. The available telemetry cannot establish malicious intent.",
    mitreMappings: [],
    baseActions: [action("check-health", "Check out-of-band host and network health", "Check power, network routes and agent service status to distinguish an outage from deliberate interference."), preserve, review, isolate],
    unmappedReason: "Heartbeat loss alone does not prove a deliberate service stop or any other ATT&CK technique.",
  },
  memory_injection: {
    name: "Memory / process injection",
    intentAnalysis: "Cross-process memory activity may indicate an attempt to run code inside another process. Correlate it with approved debugging or instrumentation before concluding it is malicious.",
    mitreMappings: [mapping("Stealth / Privilege Escalation", "T1055", "Process Injection",
      kind("memory_write"),
      (s, signals) => s.kind === "memory_write" || signals.some(w => w.kind === "memory_write" && (
        (s.kind === "remote_thread" && s.pid === w.pid && s.targetPid === w.targetPid) ||
        (s.kind === "executable_private_memory" && s.pid === w.targetPid))))],
    baseActions: [isolate, preserve, action("inspect-process", "Review source and target processes", "Capture process ancestry, memory mappings and executable provenance before terminating a process."), review],
    unmappedReason: "No validated cross-process memory write supports Process Injection.",
  },
  unmapped: {
    name: "Unclassified alert", intentAnalysis: "", mitreMappings: [],
    baseActions: [preserve, review, isolate],
    unmappedReason: "The supplied alert has no verified rule match. Review its source telemetry before assigning a technique.",
  },
};
