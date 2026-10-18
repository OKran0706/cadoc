import { TopologyNode } from "./holisticData";
import { IncidentBrief, incidentBriefSchema } from "./incidentBrief";
import { explainIncident } from "./incidentExplainer";

export interface GeminiBriefResult {
  brief: IncidentBrief;
  engine: "llm" | "rules";
  model?: string;
  error?: string;
}

/**
 * Normalizes raw LLM output into the strict IncidentBrief Zod schema invariants.
 */
function normalizeGeminiOutput(parsed: any, node: TopologyNode): any {
  if (!parsed || typeof parsed !== "object") return parsed;

  const isIsolated = Boolean(node.isolatedAt);

  parsed.engine = "llm";
  parsed.nodeId = node.id;
  parsed.nodeName = node.name;
  parsed.nodeIp = node.ip || undefined;
  parsed.alertType = node.incident?.alertType || "unknown";
  parsed.isolated = isIsolated;

  // 1. Sanitize MITRE Attack Mapping
  if (Array.isArray(parsed.attackMapping)) {
    parsed.attackMapping = parsed.attackMapping.map((m: any) => {
      let url = String(m.url || "");
      if (!url.startsWith("https://attack.mitre.org/techniques/")) {
        const techClean = String(m.techniqueId || "T1565.001").replace(".", "/");
        url = `https://attack.mitre.org/techniques/${techClean}/`;
      }
      if (!url.endsWith("/")) {
        url = url + "/";
      }
      return {
        tactic: String(m.tactic || "Impact"),
        techniqueId: String(m.techniqueId || "T1565.001"),
        techniqueName: String(m.techniqueName || "Stored Data Manipulation"),
        url,
        confidence: ["High", "Medium", "Low"].includes(m.confidence) ? m.confidence : "High",
        independentSignals: typeof m.independentSignals === "number" ? Math.max(1, m.independentSignals) : 1,
        evidenceIds: Array.isArray(m.evidenceIds) && m.evidenceIds.length > 0 ? m.evidenceIds : ["ev-1"],
        matchedReason: String(m.matchedReason || "Detected matching behavior in server telemetry logs."),
      };
    });
  }

  // 2. Sanitize Recommended Actions
  if (Array.isArray(parsed.recommendedActions)) {
    parsed.recommendedActions = parsed.recommendedActions.map((a: any, idx: number) => {
      const isIsolate = a.appActionType === "isolate_node" || String(a.action).toLowerCase().includes("isolate");
      const priority = ["Immediate", "High", "Medium", "Routine"].includes(a.priority) ? a.priority : "High";
      return {
        id: a.id || `act-${idx + 1}`,
        action: String(a.action || "Perform security containment"),
        description: String(a.description || "Review and mitigate the detected anomaly."),
        priority,
        isAppAction: isIsolate,
        appActionType: isIsolate ? ("isolate_node" as const) : undefined,
        completed: isIsolate ? isIsolated : Boolean(a.completed),
      };
    });
  }

  // 3. Sanitize Blast Radius Neighbours
  if (parsed.blastRadius && Array.isArray(parsed.blastRadius.neighbours)) {
    parsed.blastRadius.neighbours = parsed.blastRadius.neighbours.map((n: any, idx: number) => {
      const validRels = ["Cluster", "VPC", "Facility", "Country"];
      const rawRels = Array.isArray(n.relationships) ? n.relationships : ["Cluster"];
      const normalizedRels = rawRels
        .map((r: string) => {
          const lower = String(r).toLowerCase();
          if (lower.includes("vpc")) return "VPC";
          if (lower.includes("cluster")) return "Cluster";
          if (lower.includes("facility")) return "Facility";
          if (lower.includes("country")) return "Country";
          return null;
        })
        .filter((r: any): r is "Cluster" | "VPC" | "Facility" | "Country" => Boolean(r && validRels.includes(r)));

      const validStatuses = ["healthy", "warning", "tampered", "offline"];
      const status = validStatuses.includes(n.status?.toLowerCase()) ? n.status.toLowerCase() : "healthy";

      return {
        id: n.id || `peer-${idx + 1}`,
        name: n.name || `neighbor-${idx + 1}`,
        ip: n.ip || undefined,
        relationships: normalizedRels.length > 0 ? normalizedRels : ["Cluster"],
        status,
        isolated: Boolean(n.isolated),
      };
    });
  }

  // 4. Sanitize Timeline
  if (Array.isArray(parsed.timeline)) {
    const validCategories = ["baseline", "inbound", "trigger", "response"];
    parsed.timeline = parsed.timeline.map((t: any, idx: number) => {
      const catLower = String(t.category || "").toLowerCase();
      let category: "baseline" | "inbound" | "trigger" | "response" = "trigger";
      if (validCategories.includes(catLower)) {
        category = catLower as any;
      } else if (catLower.includes("base")) {
        category = "baseline";
      } else if (catLower.includes("in")) {
        category = "inbound";
      } else if (catLower.includes("resp")) {
        category = "response";
      }

      return {
        id: t.id || `tl-${idx + 1}`,
        timestamp: t.timestamp || new Date().toISOString(),
        relativeTime: t.relativeTime || `T-${idx * 15}s`,
        event: String(t.event || "Telemetry observation"),
        source: String(t.source || "Sentinel Agent"),
        category,
      };
    });
  }

  // 5. Sanitize Evidence
  if (Array.isArray(parsed.evidence)) {
    parsed.evidence = parsed.evidence.map((e: any, idx: number) => ({
      id: e.id || `ev-${idx + 1}`,
      sourceField: String(e.sourceField || "system_audit"),
      sensor: String(e.sensor || "ebpf_probe"),
      timestamp: e.timestamp || new Date().toISOString(),
      severity: ["critical", "high", "medium", "low"].includes(e.severity) ? e.severity : "critical",
      description: String(e.description || "Unusual execution pattern detected."),
    }));
  }

  return parsed;
}

/**
 * Invokes Google Gemini API to analyze raw incident telemetry and output a fully grounded IncidentBrief.
 * Falls back deterministically to the local rules engine if the API key is absent or the request fails.
 */
export async function explainIncidentWithGemini(
  node: TopologyNode,
  incident: any,
  context: { allNodes?: TopologyNode[]; apiKey?: string }
): Promise<GeminiBriefResult> {
  const apiKey =
    context.apiKey ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.NEXT_PUBLIC_GEMINI_API_KEY;

  if (!apiKey) {
    const fallbackBrief = explainIncident(node, incident, {
      allNodes: context.allNodes,
      engine: "rules",
    });
    if (!fallbackBrief) {
      throw new Error("Could not explain incident");
    }
    return {
      brief: fallbackBrief,
      engine: "rules",
      error: "No Gemini API key provided. Falling back to deterministic rules engine.",
    };
  }

  const isIsolated = Boolean(node.isolatedAt);

  const prompt = `You are a Tier-3 Cyber Incident Response Lead and Forensics Architect for CADOC Sentinel Shield.
Analyze the following active security incident telemetry and produce a plain-English, analyst-ready incident brief adhering strictly to the JSON schema.

### INCIDENT TELEMETRY DATA:
- Node Name: ${node.name} (ID: ${node.id})
- Node Type: ${node.type}
- Node IP: ${node.ip || "unknown"}
- Cloud / Region: ${node.region || node.geo?.cloudRegion || "us-east-1"} (Cluster: ${node.cluster}, VPC: ${node.vpcId || "default"})
- Facility: ${node.facility?.name} in ${node.geo?.city}, ${node.geo?.country}
- CPU Usage: ${node.cpu || 0}%, Memory: ${node.memory || 0}%
- Incident Alert: ${node.incident?.alertType || "unknown"}
- Vector: ${node.incident?.vector || "compromise"}
- Detected At: ${node.incident?.detectedAt || new Date().toISOString()}
- Raw Telemetry Signals:
${JSON.stringify(node.incident?.signals || [], null, 2)}
- Raw Telemetry Events:
${JSON.stringify(node.incident?.events || [], null, 2)}
- Cluster / VPC Neighbor Nodes:
${JSON.stringify(
  (context.allNodes || [])
    .filter(
      (n) =>
        n.id !== node.id &&
        (n.vpcId === node.vpcId ||
          n.facility?.id === node.facility?.id)
    )
    .slice(0, 8)
    .map((n) => ({ id: n.id, name: n.name, type: n.type, status: n.status, ip: n.ip, isolated: Boolean(n.isolatedAt) })),
  null,
  2
)}

### INSTRUCTIONS:
1. Ground every statement in the actual telemetry facts provided.
2. Summary: 2-3 plain-English sentences: what happened, how it was detected, and immediate impact.
3. Map the attack to the exact MITRE ATT&CK technique (e.g. T1565.001 for Ledger/Stored Data Manipulation, T1552.001 for Credentials in Files, T1562.001 for Impair Defenses/Disable Tools, T1489 for Service Stop, T1055 for Process Injection, T1068 for Privilege Escalation).
   The URL MUST match: https://attack.mitre.org/techniques/Txxxx/ (or subtechnique https://attack.mitre.org/techniques/Txxxx/xxx/).
4. Identify blast radius across shared VPC/Cluster/Facility.
5. Provide actionable recommended steps with the first action being "Isolate Node from Cluster" with isAppAction: true, appActionType: "isolate_node", completed: ${isIsolated}.
6. Output ONLY valid JSON adhering strictly to the schema.

### JSON SCHEMA:
{
  "id": "${node.incident?.id || "brief-" + node.id}",
  "engine": "llm",
  "nodeId": "${node.id}",
  "nodeName": "${node.name}",
  "nodeIp": "${node.ip || ""}",
  "alertType": "${node.incident?.alertType || "unknown"}",
  "generatedAt": "${new Date().toISOString()}",
  "detectedAt": "${node.incident?.detectedAt || new Date().toISOString()}",
  "isolated": ${isIsolated},
  "summary": "...",
  "evidence": [
    {
      "id": "ev-1",
      "sourceField": "sensor_name_or_file",
      "sensor": "auditd_or_ebpf_or_canary",
      "timestamp": "${new Date().toISOString()}",
      "severity": "critical",
      "description": "Factual description"
    }
  ],
  "attackMapping": [
    {
      "tactic": "e.g. Impact or Credential Access",
      "techniqueId": "T1565.001",
      "techniqueName": "Stored Data Manipulation",
      "url": "https://attack.mitre.org/techniques/T1565/001/",
      "confidence": "High",
      "independentSignals": 2,
      "evidenceIds": ["ev-1"],
      "matchedReason": "..."
    }
  ],
  "likelyIntent": "One sentence explaining attacker intent.",
  "blastRadius": {
    "sharedCluster": "${node.cluster || "production-k8s-mesh"}",
    "sharedVpc": "${node.vpcId || "vpc-core-prod"}",
    "sharedFacility": "${node.facility?.name || ""}",
    "sharedCountry": "${node.geo?.country || ""}",
    "neighbours": [
      {
        "id": "peer-id",
        "name": "peer-name",
        "relationships": ["Cluster", "VPC"],
        "status": "healthy",
        "isolated": false
      }
    ]
  },
  "recommendedActions": [
    {
      "id": "act-1",
      "action": "Isolate Node from Cluster",
      "description": "Sever ingress/egress network routes for this host while preserving RAM snapshot.",
      "priority": "Immediate",
      "isAppAction": true,
      "appActionType": "isolate_node",
      "completed": ${isIsolated}
    }
  ],
  "timeline": [
    {
      "id": "tl-1",
      "timestamp": "${new Date().toISOString()}",
      "relativeTime": "T-0s",
      "event": "...",
      "source": "Sentinel Agent",
      "category": "trigger"
    }
  ]
}`;

  try {
    const modelsToTry = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-pro"];
    let rawJson: string | null = null;
    let successfulModel = "gemini-2.5-flash";

    for (const model of modelsToTry) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json",
              },
            }),
          }
        );

        if (response.ok) {
          const data = await response.json();
          const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (candidateText) {
            rawJson = candidateText;
            successfulModel = model;
            break;
          }
        } else {
          const errText = await response.text();
          console.warn(`Gemini model ${model} response ${response.status}:`, errText);
        }
      } catch (e) {
        console.warn(`Error calling Gemini model ${model}:`, e);
      }
    }

    if (!rawJson) {
      throw new Error("Gemini API call failed or returned empty response");
    }

    const rawParsed = JSON.parse(rawJson);
    const normalized = normalizeGeminiOutput(rawParsed, node);

    const validation = incidentBriefSchema.safeParse(normalized);
    if (validation.success) {
      return {
        brief: validation.data,
        engine: "llm",
        model: successfulModel,
      };
    } else {
      console.warn("Gemini output validation warning, falling back to rules engine:", validation.error.format());
      const fallback = explainIncident(node, incident, {
        allNodes: context.allNodes,
        engine: "rules",
      });
      if (!fallback) throw new Error("Fallback failed");
      return {
        brief: fallback,
        engine: "rules",
        error: "Gemini output structure adjusted to match incident brief schema.",
      };
    }
  } catch (err: any) {
    console.warn("Gemini API failed, using rules engine fallback:", err);
    const fallback = explainIncident(node, incident, {
      allNodes: context.allNodes,
      engine: "rules",
    });
    if (!fallback) throw new Error("Fallback failed: " + err.message);
    return {
      brief: fallback,
      engine: "rules",
      error: err.message || "Gemini API error",
    };
  }
}
