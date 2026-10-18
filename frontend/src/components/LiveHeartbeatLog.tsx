"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { nodeService } from "@/services/nodeService";
import { serverService } from "@/services/serverService";
import { agentService } from "@/services/agentService";
import { dashboardService } from "@/services/dashboardService";
import { adminService } from "@/services/adminService";
import type { AlertPayload, NodeInventory, AuditLogEntry, ServerResponse } from "@/lib/types";

type Tag =
  | "SYSTEM"
  | "WATCH"
  | "DECPTN"
  | "TRAFFIC"
  | "AUTH"
  | "CRYPTO"
  | "HEARTBEAT"
  | "ALERT"
  | "OFFLINE";

interface LogEntry {
  id: string;
  ts: string;
  tag: Tag;
  msg: string;
}

const TAG_STYLE: Record<Tag, string> = {
  SYSTEM: "text-cyan-400",
  WATCH: "text-amber-400",
  DECPTN: "text-emerald-400",
  TRAFFIC: "text-purple-400",
  AUTH: "text-blue-400",
  CRYPTO: "text-rose-400",
  HEARTBEAT: "text-emerald-400 font-semibold",
  ALERT: "text-red-400 font-bold",
  OFFLINE: "text-zinc-500 font-semibold",
};

function formatNow(): string {
  return new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatIso(isoString?: string): string {
  if (!isoString) return formatNow();
  try {
    return new Date(isoString).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return formatNow();
  }
}

export interface LiveHeartbeatServerData {
  id?: string;
  serverId?: string;
  hostname?: string;
  ip?: string;
  status?: string;
  cpu?: number | null;
  memoryUsed?: number | null;
  memoryTotal?: number | null;
  threats?: number;
  isOnline?: boolean;
  location?: string;
}

interface Props {
  nodeId?: string; // if provided, filters telemetry and stream for this node
  serverData?: LiveHeartbeatServerData; // server data passed directly from card
  intervalMs?: number; // polling frequency for node heartbeat verification
  maxEntries?: number; // how many lines to keep in buffer
  height?: string; // CSS height
}

export function LiveHeartbeatLog({
  nodeId,
  serverData,
  intervalMs = 5000,
  maxEntries = 50,
  height = "220px",
}: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState<boolean>(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastStateRef = useRef<string>("");
  const lastGlobalSyncRef = useRef<string>("");
  const lastNodeStatesRef = useRef<Map<string, string>>(new Map());

  const appendEntry = useCallback((tag: Tag, msg: string, customTs?: string) => {
    setEntries((prev) => {
      const entry: LogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        ts: customTs || formatNow(),
        tag,
        msg: nodeId ? `[${nodeId}] ${msg}` : msg,
      };
      return [entry, ...prev].slice(0, maxEntries);
    });
  }, [nodeId, maxEntries]);

  // 1. Initial Load of Genuine Cluster History for Global Feed
  useEffect(() => {
    if (!nodeId) {
      // Ingest recent security alerts
      dashboardService
        .getAlerts(undefined, 10)
        .then((res) => {
          if (res.data && res.data.length > 0) {
            res.data.slice(0, 5).forEach((alert: AlertPayload) => {
              appendEntry(
                "ALERT",
                `[${alert.server_id || "cluster"}] Security event: ${alert.event_type || "signal"} (${(alert.severity || "INFO").toUpperCase()}) — ${alert.details && typeof alert.details.message === "string"
                  ? alert.details.message
                  : "Signal registered"
                }`,
                formatIso(alert.detected_at)
              );
            });
          }
        })
        .catch(() => { });

      // Ingest recent administrative audit actions if available
      adminService
        .getAuditLogs(5, 0)
        .then((logs: AuditLogEntry[]) => {
          if (Array.isArray(logs) && logs.length > 0) {
            logs.slice(0, 3).forEach((log: AuditLogEntry) => {
              appendEntry(
                "AUTH",
                `Admin audit: ${log.action} on ${log.resource_type || "system"} (${log.status})`,
                formatIso(log.created_at || log.timestamp || log.ts)
              );
            });
          }
        })
        .catch(() => { });
    }
  }, [nodeId, appendEntry]);

  // 2. Live Heartbeat Verification via node telemetry endpoint
  useEffect(() => {
    let active = true;

    async function checkHeartbeat() {
      try {
        const nodes: NodeInventory[] = await nodeService
          .getNodes()
          .catch(() => [] as NodeInventory[]);
        if (!active) return;

        if (nodeId) {
          // Strict Real Heartbeat: only consider node connected and emitting pulses
          // if an actual active telemetry record exists in GET /api/v1/dashboard/nodes
          let telemetryMatch: NodeInventory | undefined;

          if (Array.isArray(nodes) && nodes.length > 0) {
            const rawIp = (nodeId || "").split("/")[0].trim();
            telemetryMatch = nodes.find(
              (n) =>
                n.id === nodeId ||
                n.server_id === nodeId ||
                n.serverId === nodeId ||
                (serverData && (
                  n.id === serverData.id ||
                  n.id === serverData.serverId ||
                  (serverData.ip && n.ip && (n.ip === serverData.ip || n.ip.startsWith(rawIp)))
                ))
            );
          }

          if (telemetryMatch) {
            const isOnline = ["online", "active", "healthy"].includes(
              (telemetryMatch.status || "").toLowerCase()
            );
            setConnected(isOnline);

            const hasCpu = typeof telemetryMatch.cpu === "number";
            const hasMem = typeof telemetryMatch.memoryUsed === "number";
            const cpu = hasCpu ? Math.round(telemetryMatch.cpu!) : null;
            const mem =
              hasMem && telemetryMatch.memoryTotal
                ? Math.round((telemetryMatch.memoryUsed! / telemetryMatch.memoryTotal) * 100)
                : typeof telemetryMatch.memoryUsed === "number"
                  ? Math.round(telemetryMatch.memoryUsed)
                  : null;

            const telemetryDetails = [
              cpu !== null ? `CPU: ${cpu}%` : null,
              mem !== null ? `Mem: ${mem}%` : null,
              `IP: ${telemetryMatch.ip || serverData?.ip || "N/A"}`,
            ]
              .filter(Boolean)
              .join(" | ");

            const stateSnapshot = `${telemetryMatch.status}-${cpu}-${mem}-${telemetryMatch.threats || 0}`;

            if (isOnline) {
              // Only log when genuine telemetry changes
              if (lastStateRef.current !== stateSnapshot) {
                appendEntry(
                  "HEARTBEAT",
                  `Daemon pulse ACK: ${telemetryMatch.status.toUpperCase()} | ${telemetryDetails}`
                );
              }

              if (telemetryMatch.threats > 0 && lastStateRef.current !== stateSnapshot) {
                appendEntry(
                  "WATCH",
                  `Active threats flagged: ${telemetryMatch.threats} incident(s) under observation`
                );
              }
            } else if (lastStateRef.current !== stateSnapshot) {
              appendEntry(
                "OFFLINE",
                `Node status: ${telemetryMatch.status.toUpperCase()} — heartbeat unacknowledged`
              );
            }
            lastStateRef.current = stateSnapshot;
          } else {
            // Strict mode: No live telemetry in nodes API -> not connected, no fake pulse!
            setConnected(false);
            if (lastStateRef.current !== "no-telemetry") {
              appendEntry("OFFLINE", `Awaiting initial daemon heartbeat from node telemetry`);
              lastStateRef.current = "no-telemetry";
            }
          }
        } else {
          // Global Cluster Feed
          const onlineNodes = nodes.filter((n) =>
            ["online", "active", "healthy"].includes((n.status || "").toLowerCase())
          );
          setConnected(onlineNodes.length > 0);

          const syncKey = `${onlineNodes.length}/${nodes.length}`;
          // Only emit cluster sync line if node count changed or on initial load
          if (lastGlobalSyncRef.current !== syncKey) {
            appendEntry(
              "SYSTEM",
              `Cluster telemetry sync: ${onlineNodes.length}/${nodes.length} nodes active and reporting heartbeats`
            );
            lastGlobalSyncRef.current = syncKey;
          }

          // For each active node, emit its heartbeat pulse only when telemetry actually updates
          onlineNodes.forEach((n) => {
            const cpu = typeof n.cpu === "number" ? Math.round(n.cpu) : 0;
            const mem =
              n.memoryTotal && n.memoryUsed
                ? Math.round((n.memoryUsed / n.memoryTotal) * 100)
                : typeof n.memoryUsed === "number"
                  ? Math.round(n.memoryUsed)
                  : 0;

            const nodeSnapshot = `${n.id}-${n.status}-${cpu}-${mem}-${n.threats}`;
            const prev = lastNodeStatesRef.current.get(n.id);

            if (prev !== nodeSnapshot) {
              appendEntry(
                "HEARTBEAT",
                `[${n.id}] Pulse ACK: ${n.status.toUpperCase()} | ${n.location || "Cluster"} | IP: ${n.ip} | CPU: ${cpu}% | Mem: ${mem}%`
              );
              lastNodeStatesRef.current.set(n.id, nodeSnapshot);

              if (n.threats > 0 && prev !== nodeSnapshot) {
                appendEntry(
                  "WATCH",
                  `[${n.id}] Telemetry alert: ${n.threats} active threat vectors flagged`
                );
              }
            }
          });
        }
      } catch (err: any) {
        if (!active) return;
        setConnected(false);
        if (lastStateRef.current !== "error") {
          appendEntry("SYSTEM", `Heartbeat poll failure: ${err.message || "Connection refused"}`);
          lastStateRef.current = "error";
        }
      }
    }

    // Initial check
    checkHeartbeat();
    const timer = setInterval(checkHeartbeat, Math.max(intervalMs, 3000));

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [nodeId, intervalMs, appendEntry]);

  // 3. Real-Time SSE Stream for security alerts & audit events
  useEffect(() => {
    let sse: EventSource | null = null;
    try {
      sse = dashboardService.getAlertStream();
    } catch {
      // Stream unavailable
    }

    if (sse) {
      sse.onmessage = (event) => {
        try {
          const alert: AlertPayload = JSON.parse(event.data);
          if (!nodeId || alert.server_id === nodeId) {
            appendEntry(
              "ALERT",
              `Real-time alert: ${alert.event_type || "signal"} [${(alert.severity || "INFO").toUpperCase()}] on server ${alert.server_id || "cluster"}`
            );
          }
        } catch {
          // Ignore keep-alive comments
        }
      };

      sse.onerror = () => {
        // Handled silently; polling continues
      };
    }

    return () => {
      if (sse) sse.close();
    };
  }, [nodeId, appendEntry]);

  return (
    <div className="rounded-xl overflow-hidden border border-white/5" style={{ height }}>
      {/* Header with live dynamic status badge */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#111827] border-b border-white/5">
        <span className="text-[9px] font-bold text-white/50 uppercase tracking-[0.15em]">
          {nodeId ? "Live Node Telemetry" : "Cluster Event Feed"}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-400 animate-pulse" : "bg-zinc-500"
              } inline-block`}
          />
          <span
            className={`text-[9px] font-mono ${connected ? "text-emerald-400" : "text-zinc-500"
              }`}
          >
            {connected ? "LIVE" : "DISCONNECTED"}
          </span>
        </span>
      </div>

      {/* Log scroll area */}
      <div
        ref={scrollRef}
        className="overflow-y-auto bg-[#0d1117] px-3 py-2 space-y-1 font-mono text-[10px] leading-5"
        style={{ height: `calc(${height} - 34px)` }}
      >
        {entries.length === 0 ? (
          <div className="text-white/40 text-[10px] italic py-2">
            Awaiting live heartbeat from telemetry broker...
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="flex gap-2 animate-[fadeIn_0.3s_ease] items-start">
              <span className="text-white/30 shrink-0 tabular-nums">{e.ts}</span>
              <span className={`font-bold shrink-0 ${TAG_STYLE[e.tag] || "text-white/60"}`}>
                [{e.tag}]
              </span>
              <span className="text-white/80">{e.msg}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
