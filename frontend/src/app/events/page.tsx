"use client";

import { DashboardLayout } from "@/components/DashboardLayout";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  AlertTriangle, Filter, Search, Clock, ChevronDown,
  Info, Loader2, Server, ShieldCheck, Crosshair,
  ShieldAlert, Copy, Check, Terminal, Activity,
  RefreshCw, Layers
} from "lucide-react";
import { dashboardService } from "@/services/dashboardService";
import { serverService } from "@/services/serverService";
import { nodeService } from "@/services/nodeService";
import { decoyService } from "@/services/decoyService";
import { getQuarantineDisplayStatus, getQuarantineKillParent } from "@/lib/eventActions";
import { usePermissions } from "@/lib/rbac";
import type { AlertPayload, ServerResponse, NodeInventory, DecoyResponse } from "@/lib/types";

const badgeColor: Record<string, string> = {
  critical: "bg-error-container text-error border-error/20",
  warning: "bg-amber-100 text-amber-800 border-amber-200",
  info: "bg-primary/5 text-primary border-primary/20",
  high: "bg-error-container text-error border-error/20",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-primary/5 text-primary border-primary/20",
};

const severityDot = (severity?: string) => {
  const s = (severity || "").toLowerCase();
  if (s === "critical" || s === "high") return "bg-error";
  if (s === "medium" || s === "warning") return "bg-amber-500";
  if (s === "low" || s === "info") return "bg-emerald-500";
  return "bg-primary";
};

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return isoString;
  }
}

function timeAgo(isoString: string): string {
  try {
    const d = new Date(isoString);
    const secs = Math.floor((Date.now() - d.getTime()) / 1000);
    if (secs < 60) return "just now";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  } catch {
    return "";
  }
}

function getAlertDescription(alert: AlertPayload): string {
  if (alert.details && typeof alert.details.message === "string") {
    return alert.details.message;
  }
  if (alert.details && Object.keys(alert.details).length > 0) {
    const parts = Object.entries(alert.details)
      .filter(([k]) => !["pid", "process_id", "severity"].includes(k))
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`);
    if (parts.length > 0) return parts.join(" • ");
  }
  return `Security signal of type ${alert.event_type || "Telemetry"} registered on host ${alert.server_id || "Cluster"}`;
}

export default function EventsPage() {
  const { can } = usePermissions();
  const canRespond = can("security.respond");
  const [events, setEvents] = useState<AlertPayload[]>([]);
  const [servers, setServers] = useState<ServerResponse[]>([]);
  const [nodes, setNodes] = useState<NodeInventory[]>([]);
  const [decoys, setDecoys] = useState<DecoyResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState<"All" | "Critical" | "Warning" | "Info">("All");
  const [searchQuery, setSearchQuery] = useState("");

  // Inline inspection state
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [eventDecoys, setEventDecoys] = useState<Record<string, DecoyResponse | null>>({});
  const [loadingDecoyIds, setLoadingDecoyIds] = useState<Set<string>>(new Set());
  const pendingActionIds = useRef<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [quarantineRequestedIds, setQuarantineRequestedIds] = useState<Set<string>>(new Set());
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [copiedHash, setCopiedHash] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  // Load telemetry, servers, nodes, and decoys
  const loadInitialData = useCallback(async () => {
    setLoading(true);
    try {
      const [alertsRes, serversRes, nodesRes, decoysRes] = await Promise.all([
        dashboardService.getAlerts(undefined, 100).catch(() => ({ data: [] })),
        serverService.listServers().catch(() => [] as ServerResponse[]),
        nodeService.getNodes().catch(() => [] as NodeInventory[]),
        decoyService.listDecoys().catch(() => [] as DecoyResponse[]),
      ]);

      const incoming = alertsRes?.data || (Array.isArray(alertsRes) ? alertsRes : []);
      setEvents(Array.isArray(incoming) ? incoming : []);
      setServers(Array.isArray(serversRes) ? serversRes : []);
      setNodes(Array.isArray(nodesRes) ? nodesRes : []);
      setDecoys(Array.isArray(decoysRes) ? decoysRes : []);
    } catch (err) {
      console.error("Failed to load events telemetry:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInitialData();

    // Establish real-time SSE stream
    const es = dashboardService.getAlertStream();
    if (es) {
      es.onopen = () => setConnected(true);
      es.onmessage = (event) => {
        try {
          const alert: AlertPayload = JSON.parse(event.data);
          setEvents((prev) => {
            const existingIndex = prev.findIndex((e) => e.id === alert.id);
            if (existingIndex >= 0) {
              const next = [...prev];
              next[existingIndex] = alert;
              return next;
            }
            return [alert, ...prev].slice(0, 200);
          });
        } catch {
          // ignore keep-alive pings
        }
      };
      es.onerror = () => {
        setConnected(false);
        es.close();
      };
      return () => es.close();
    }
  }, [loadInitialData]);

  // Fallback Polling Mode: when SSE stream is disconnected, poll for alerts in background
  useEffect(() => {
    if (connected) return;

    const pollTimer = setInterval(async () => {
      try {
        const res = await dashboardService.getAlerts(undefined, 50);
        const freshAlerts = res?.data || (Array.isArray(res) ? res : []);
        if (Array.isArray(freshAlerts) && freshAlerts.length > 0) {
          setEvents((prev) => {
            const existingIds = new Set(prev.map((e) => e.id));
            const newEntries = freshAlerts.filter((a) => a.id && !existingIds.has(a.id));
            const freshById = new Map(freshAlerts.map((a) => [a.id, a]));
            return [...newEntries, ...prev.map((e) => freshById.get(e.id) || e)].slice(0, 200);
          });
        }
      } catch {
        // Silent retry on next polling cycle
      }
    }, 5000);

    return () => clearInterval(pollTimer);
  }, [connected]);

  // Resolves rich server info from serverId, top-level hostname, and alert details
  const getServerInfo = useCallback(
    (serverId?: string, hostname?: string, details?: Record<string, unknown>) => {
      // 1. Direct top-level hostname on alert takes highest precedence (e.g. "pikachu")
      const explicitHost =
        hostname ||
        (details?.hostname as string) ||
        (details?.host as string) ||
        (details?.server_name as string) ||
        (details?.node_name as string) ||
        (details?.node as string);

      const targetId = serverId || "";

      // 2. Lookup in provisioned servers
      const s = servers.find((srv) => srv.id === targetId || srv.hostname === targetId);
      if (s) {
        return {
          name: explicitHost || s.hostname || targetId,
          id: s.id,
          ip: s.ip_address || (details?.ip as string) || (details?.source_ip as string) || "—",
          status: s.status || "active",
          location: (s.specs?.location as string) || "Cloud Node",
        };
      }

      // 3. Lookup in cluster node inventory
      const n = nodes.find(
        (node) =>
          node.id === targetId ||
          node.server_id === targetId ||
          node.serverId === targetId ||
          node.hostname === targetId ||
          node.host_name === targetId
      );
      if (n) {
        return {
          name: explicitHost || n.hostname || n.host_name || n.id,
          id: n.serverId || n.server_id || n.id,
          ip: n.ip || (details?.ip as string) || (details?.source_ip as string) || "—",
          status: n.status || "active",
          location: n.location || "Cluster Node",
        };
      }

      // 4. Fallback: formatted display name
      return {
        name: explicitHost || targetId || "Cluster Node",
        id: targetId || "—",
        ip: (details?.ip as string) || (details?.source_ip as string) || "—",
        status: "active",
        location: "Cluster Node",
      };
    },
    [servers, nodes]
  );

  // Toggle inline expansion for an alert card
  const toggleExpandEvent = async (e: AlertPayload) => {
    const isExpanded = expandedIds.has(e.id);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (isExpanded) {
        next.delete(e.id);
      } else {
        next.add(e.id);
      }
      return next;
    });

    if (!isExpanded && !eventDecoys[e.id]) {
      const candidateId =
        (e.details?.decoy_id as string) ||
        (e.details?.decoyId as string) ||
        (e.details?.asset_id as string);

      let decoyToFetch = candidateId;

      if (!decoyToFetch) {
        const filePath = (e.details?.file_path || e.details?.path) as string;
        const matched = decoys.find(
          (d) =>
            (filePath && d.file_path && d.file_path.toLowerCase() === filePath.toLowerCase()) ||
            (d.server_id && d.server_id === e.server_id)
        );
        if (matched) {
          decoyToFetch = matched.id;
        }
      }

      if (decoyToFetch) {
        setLoadingDecoyIds((prev) => new Set(prev).add(e.id));
        try {
          const decoy = await decoyService.getDecoy(decoyToFetch);
          setEventDecoys((prev) => ({ ...prev, [e.id]: decoy }));
        } catch {
          const cached = decoys.find((d) => d.id === decoyToFetch);
          setEventDecoys((prev) => ({ ...prev, [e.id]: cached || null }));
        } finally {
          setLoadingDecoyIds((prev) => {
            const next = new Set(prev);
            next.delete(e.id);
            return next;
          });
        }
      }
    }
  };

  const handleQuarantine = async (alertId: string, killParent: boolean, event: React.MouseEvent) => {
    event.stopPropagation();
    const currentAlert = events.find((item) => item.id === alertId);
    if (!canRespond || !currentAlert || pendingActionIds.current.has(alertId)) return;
    if (getQuarantineDisplayStatus(currentAlert, quarantineRequestedIds.has(alertId))) return;
    if (getQuarantineKillParent(currentAlert, eventDecoys[alertId]) !== killParent) return;
    pendingActionIds.current.add(alertId);
    setPendingIds((prev) => new Set(prev).add(alertId));
    setActionErrors((prev) => {
      const next = { ...prev };
      delete next[alertId];
      return next;
    });
    try {
      await dashboardService.quarantineAlert(alertId, killParent);
      setQuarantineRequestedIds((prev) => new Set(prev).add(alertId));
    } catch {
      setActionErrors((prev) => ({ ...prev, [alertId]: "Quarantine failed. Please try again." }));
    } finally {
      pendingActionIds.current.delete(alertId);
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(alertId);
        return next;
      });
    }
  };

  const copyToClipboard = (text: string, setter: (v: boolean) => void) => {
    navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  };

  // Counts calculations
  const totalCount = events.length;
  const criticalCount = events.filter((e) => {
    const s = (e.severity || "").toLowerCase();
    return s === "critical" || s === "high";
  }).length;
  const warningCount = events.filter((e) => {
    const s = (e.severity || "").toLowerCase();
    return s === "warning" || s === "medium";
  }).length;
  const infoCount = events.filter((e) => {
    const s = (e.severity || "").toLowerCase();
    return s === "info" || s === "low";
  }).length;

  // Filtered Events
  const filteredEvents = events.filter((e) => {
    if (filter !== "All") {
      const sev = (e.severity || "").toLowerCase();
      const f = filter.toLowerCase();
      if (f === "critical" && sev !== "critical" && sev !== "high") return false;
      if (f === "warning" && sev !== "warning" && sev !== "medium") return false;
      if (f === "info" && sev !== "info" && sev !== "low") return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const type = (e.event_type || "").toLowerCase();
      const desc = getAlertDescription(e).toLowerCase();
      const node = (e.server_id || "").toLowerCase();
      const serverName = getServerInfo(e.server_id, e.hostname, e.details).name.toLowerCase();
      return type.includes(q) || desc.includes(q) || node.includes(q) || serverName.includes(q);
    }
    return true;
  });

  return (
    <DashboardLayout>
      <header className="flex justify-between items-end mb-5">
        <div>
          <h1 className="text-2xl font-bold text-primary -tracking-wider">Live Event Stream</h1>
          <p className="text-xs text-on-surface-variant mt-0.5">Real-time prioritised telemetry and cyber-deception signals</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={loadInitialData}
            className="p-2 bg-surface-container-low hover:bg-surface-container-high rounded-full transition-colors text-primary"
            title="Refresh events"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container-low border border-outline-variant/15 text-xs font-mono">
            <span className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-amber-500"}`} />
            {connected ? "Live Stream Active" : "Polling Mode"}
          </div>
        </div>
      </header>

      {/* Metric Counters */}
      <div className="grid grid-cols-4 gap-4 mb-5">
        {[
          { label: "Total Alerts", value: totalCount, color: "text-primary", bg: "bg-primary/5" },
          { label: "Critical Priority", value: criticalCount, color: "text-error", bg: "bg-error-container/20" },
          { label: "Warnings", value: warningCount, color: "text-amber-700", bg: "bg-amber-100" },
          { label: "Info Signals", value: infoCount, color: "text-primary", bg: "bg-surface-container-low" },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl ${s.bg} flex items-center justify-center shrink-0`}>
              <Activity className={`w-5 h-5 ${s.color}`} />
            </div>
            <div>
              <p className="text-2xl font-bold text-on-surface">{s.value}</p>
              <p className="text-[10px] text-on-surface-variant font-medium uppercase tracking-widest">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filter Bar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center bg-surface-container-high px-3.5 py-2 rounded-full flex-1 max-w-sm border border-outline-variant/15">
          <Search className="text-on-surface-variant/50 w-4 h-4 mr-2" />
          <input
            className="bg-transparent border-none outline-none text-xs w-full text-on-surface placeholder:text-on-surface-variant/40"
            placeholder="Search by event type, description, or hostname..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        {(["All", "Critical", "Warning", "Info"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all shadow-sm ${
              filter === f
                ? "bg-primary text-white shadow-primary/20"
                : "bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest"
            }`}
          >
            {f}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-xs text-on-surface-variant">
          <Layers className="w-3.5 h-3.5 text-primary" />
          <span className="font-mono text-[11px] font-semibold">{filteredEvents.length} Signals</span>
        </div>
      </div>

      {/* Events List */}
      <div className="space-y-3">
        {loading && events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 bg-white rounded-2xl border border-outline-variant/10 shadow-sm">
            <Loader2 className="w-8 h-8 text-primary animate-spin mb-3" />
            <p className="text-xs text-on-surface-variant font-medium">Ingesting live security events and server metadata...</p>
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 border border-outline-variant/10 text-center shadow-sm">
            <Clock className="w-12 h-12 text-outline-variant mx-auto mb-4 opacity-50" />
            <h3 className="text-base font-bold text-on-surface">No Events Found</h3>
            <p className="text-xs text-on-surface-variant max-w-sm mx-auto mt-2">
              {searchQuery || filter !== "All"
                ? "No events match the current filter or search criteria. Try modifying your filter options."
                : "There are no live security events registered on your tenant yet. Active agents will stream telemetry events here in real-time."}
            </p>
          </div>
        ) : (
          filteredEvents.map((e, idx) => {
            const rawSev = (e.severity || "info").toLowerCase();
            const displaySeverity = rawSev as keyof typeof badgeColor;
            const badgeLabel = (e.severity || "info").toUpperCase();
            const serverInfo = getServerInfo(e.server_id, e.hostname, e.details);
            const pid = (e.details?.pid || e.details?.process_id) as string | undefined;
            const eventTypeStr = (e.event_type || "").toLowerCase();
            const hasDecoyLink =
              Boolean(e.details?.decoy_id || e.details?.decoyId || e.details?.file_path) ||
              eventTypeStr.includes("decoy") ||
              eventTypeStr.includes("canary") ||
              decoys.some((d) => d.server_id === e.server_id);

            const isExpanded = expandedIds.has(e.id);
            const decoy = eventDecoys[e.id];
            const isLoadingDecoy = loadingDecoyIds.has(e.id);
            const quarantineStatus = getQuarantineDisplayStatus(e, quarantineRequestedIds.has(e.id));
            const killParent = getQuarantineKillParent(e, decoy);

            return (
              <div
                key={e.id || `event-${idx}`}
                className={`bg-white rounded-xl border transition-all duration-200 overflow-hidden shadow-sm hover:shadow-md ${
                  isExpanded
                    ? "border-primary/40 ring-1 ring-primary/20 shadow-md"
                    : "border-outline-variant/10 hover:border-outline-variant/25"
                }`}
              >
                {/* Main Card Header (Click to toggle expansion) */}
                <div
                  onClick={() => toggleExpandEvent(e)}
                  className="p-4 cursor-pointer flex items-start gap-4 select-none"
                >
                  {/* Severity Status Indicator */}
                  <div className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${severityDot(e.severity)}`} />

                  <div className="flex-1 min-w-0">
                    {/* Top Bar: Severity Badge + Event Type + Hostname Badge + Deception Tag */}
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <span
                        className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md border ${
                          badgeColor[displaySeverity] || "bg-primary/5 text-primary border-primary/20"
                        }`}
                      >
                        {badgeLabel}
                      </span>

                      <h3 className="text-sm font-bold text-on-surface group-hover:text-primary transition-colors">
                        {e.event_type || "Security Signal"}
                      </h3>

                      {/* Server Hostname Badge with verified host name */}
                      <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-surface-container-low border border-outline-variant/15 text-[11px] font-medium text-on-surface">
                        <Server className="w-3 h-3 text-primary" />
                        <span className="font-bold text-primary font-mono">{serverInfo.name}</span>
                        {serverInfo.ip && serverInfo.ip !== "—" && (
                          <span className="text-[10px] text-on-surface-variant/70 font-mono">({serverInfo.ip})</span>
                        )}
                      </div>

                      {/* Enterprise Deception Tag: Replaces pink/purple ghost tag */}
                      {hasDecoyLink && (
                        <span className="flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-md bg-slate-900 text-cyan-400 border border-cyan-800/40 font-mono tracking-wide">
                          <Crosshair className="w-3 h-3 text-cyan-400" />
                          DECOY TRIPWIRE
                        </span>
                      )}

                      {quarantineStatus && (
                        <span className={`flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-md border ${quarantineStatus === "requested" ? "bg-amber-100 text-amber-800 border-amber-200" : "bg-emerald-100 text-emerald-800 border-emerald-200"}`}>
                          {quarantineStatus === "requested" ? <Clock className="w-3 h-3" /> : <ShieldCheck className="w-3 h-3 text-emerald-700" />}
                          {quarantineStatus === "requested" ? "QUARANTINE REQUESTED" : "QUARANTINED"}
                        </span>
                      )}
                    </div>

                    {/* Description / Message */}
                    <p className="text-xs text-on-surface-variant line-clamp-2 leading-relaxed" title={getAlertDescription(e)}>
                      {getAlertDescription(e)}
                    </p>

                    {/* Context Meta Pills */}
                    <div className="flex flex-wrap items-center gap-3 mt-2 text-[10px] text-on-surface-variant/70 font-mono">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3 text-primary/60" />
                        {formatTime(e.detected_at)} {timeAgo(e.detected_at) && `(${timeAgo(e.detected_at)})`}
                      </span>
                      {pid && (
                        <span className="flex items-center gap-1 bg-surface-container-high px-1.5 py-0.5 rounded">
                          <Terminal className="w-2.5 h-2.5" /> PID: {pid}
                        </span>
                      )}
                      <span className="text-primary/70">ID: {typeof e.id === "string" ? e.id.slice(0, 8) : "—"}</span>
                    </div>
                  </div>

                  {/* Inline Toggle Button (Chevron) */}
                  <div className="flex items-center gap-1.5 text-xs text-primary font-semibold shrink-0 mt-1 px-2.5 py-1 rounded-full bg-surface-container-low hover:bg-surface-container-high transition-colors">
                    <span className="text-[11px]">{isExpanded ? "Collapse" : "Inspect"}</span>
                    <ChevronDown className={`w-3.5 h-3.5 text-primary transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`} />
                  </div>
                </div>

                {/* ── Inline Expanded Details View ── */}
                {isExpanded && (
                  <div className="border-t border-outline-variant/10 bg-surface-container-lowest/50 p-5 space-y-4 animate-[fadeIn_0.2s_ease-out]">
                    {/* Grid 1: Host and Infrastructure Context */}
                    <div className="bg-white rounded-xl p-4 border border-outline-variant/15 shadow-sm">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-primary flex items-center gap-1.5">
                          <Server className="w-3.5 h-3.5 text-primary" /> Target Node & Host Context
                        </span>
                        <span className="text-[10px] font-mono text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded font-bold">
                          {serverInfo.status.toUpperCase()}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                        <div>
                          <p className="text-[10px] font-medium text-on-surface-variant uppercase">Hostname</p>
                          <p className="font-bold text-on-surface font-mono">{serverInfo.name}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-medium text-on-surface-variant uppercase">IP Address</p>
                          <p className="font-bold text-on-surface font-mono">{serverInfo.ip}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-medium text-on-surface-variant uppercase">Server Identifier</p>
                          <p className="font-mono text-[11px] text-on-surface truncate" title={serverInfo.id}>{serverInfo.id}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-medium text-on-surface-variant uppercase">Cluster Location</p>
                          <p className="font-semibold text-on-surface">{serverInfo.location}</p>
                        </div>
                      </div>
                    </div>

                    {/* Grid 2: Decoy / Canary Tripwire Asset Details (Enterprise Styling) */}
                    {hasDecoyLink && (
                      <div className="bg-[#0b101b] text-slate-200 rounded-xl p-4 border border-cyan-900/40 shadow-sm">
                        <div className="flex items-center justify-between mb-3 pb-2 border-b border-cyan-900/30">
                          <div className="flex items-center gap-2">
                            <Crosshair className="w-4 h-4 text-cyan-400" />
                            <h4 className="text-xs font-bold uppercase tracking-widest text-cyan-300 font-mono">
                              Decoy Tripwire Intelligence
                            </h4>
                          </div>
                          <span className="text-[9px] font-mono text-cyan-400 bg-cyan-950 px-2 py-0.5 rounded border border-cyan-800/50">
                            CYBER DECEPTION ASSET
                          </span>
                        </div>

                        {isLoadingDecoy ? (
                          <div className="flex items-center justify-center py-4 gap-2 text-cyan-400 text-xs">
                            <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
                            <span>Retrieving decoy fingerprint...</span>
                          </div>
                        ) : decoy ? (
                          <div className="space-y-2.5 text-xs">
                            <div className="flex justify-between items-start gap-4">
                              <div>
                                <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Honeytoken File Path</p>
                                <p className="font-mono text-xs font-bold text-cyan-300 break-all">{decoy.file_path}</p>
                              </div>
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-red-950 text-red-400 border border-red-800/40 shrink-0">
                                {decoy.status}
                              </span>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-[11px] pt-2 border-t border-white/5">
                              <div>
                                <span className="text-slate-400">Decoy Type:</span> <strong className="text-white">{decoy.decoy_type}</strong>
                              </div>
                              <div>
                                <span className="text-slate-400">Planted:</span> <strong className="text-white font-mono">{new Date(decoy.planted_at).toLocaleString()}</strong>
                              </div>
                            </div>
                            {decoy.original_hash && (
                              <div className="pt-2 border-t border-white/5">
                                <div className="flex justify-between items-center mb-1">
                                  <span className="text-[9px] font-bold uppercase text-slate-400 font-mono">SHA256 Fingerprint</span>
                                  <button
                                    onClick={(ev) => { ev.stopPropagation(); copyToClipboard(decoy.original_hash, setCopiedHash); }}
                                    className="text-[10px] font-bold text-cyan-400 flex items-center gap-1 hover:underline"
                                  >
                                    {copiedHash ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                                    {copiedHash ? "Copied" : "Copy Hash"}
                                  </button>
                                </div>
                                <p className="font-mono text-[10px] text-slate-300 bg-black/50 p-2 rounded break-all border border-white/5">
                                  {decoy.original_hash}
                                </p>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-[11px] text-slate-400 py-2">
                            Decoy tripwire triggered on server host. Honeytoken record registered in deception partition.
                          </div>
                        )}
                      </div>
                    )}

                    {/* Grid 3: Signal Attributes & Raw Payload */}
                    <div className="bg-[#0e1117] rounded-xl p-4 border border-outline-variant/20 shadow-sm">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400 font-mono flex items-center gap-1.5">
                          <Terminal className="w-3.5 h-3.5" /> Telemetry Signal Data
                        </span>
                        <button
                          onClick={(ev) => { ev.stopPropagation(); copyToClipboard(JSON.stringify(e, null, 2), setCopiedJson); }}
                          className="text-[10px] font-bold text-zinc-400 hover:text-white flex items-center gap-1 transition-colors"
                        >
                          {copiedJson ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                          {copiedJson ? "Copied JSON" : "Copy Payload"}
                        </button>
                      </div>
                      <pre className="text-[11px] font-mono text-emerald-400 whitespace-pre-wrap break-all overflow-x-auto max-h-44 select-all leading-5 bg-black/40 p-2.5 rounded-lg border border-white/5">
                        {JSON.stringify(e, null, 2)}
                      </pre>
                    </div>

                    {/* Alert response action bar */}
                    <div className="flex justify-between items-center pt-2">
                      <span className="text-[10px] font-mono text-on-surface-variant">Alert ID: {e.id}</span>
                      <div className="flex gap-2">
                        {killParent !== null && !quarantineStatus && (
                          <button
                            type="button"
                            onClick={(ev) => handleQuarantine(e.id, killParent, ev)}
                            disabled={pendingIds.has(e.id) || !canRespond || !e.id}
                            title={!canRespond ? "Requires security.respond permission" : undefined}
                            className="px-4 py-1.5 rounded-full text-xs font-bold bg-error text-white hover:bg-error/90 transition-colors flex items-center gap-1.5 shadow-sm shadow-error/20 disabled:opacity-50"
                          >
                            {pendingIds.has(e.id) ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldAlert className="w-3 h-3" />}
                            {pendingIds.has(e.id) ? "Quarantining..." : "Quarantine"}
                          </button>
                        )}
                        <button
                          onClick={() => toggleExpandEvent(e)}
                          className="px-3.5 py-1.5 rounded-full text-xs font-medium bg-surface-container-high text-on-surface hover:bg-surface-container-highest transition-colors"
                        >
                          Collapse
                        </button>
                      </div>
                    </div>
                    {actionErrors[e.id] && <p role="alert" className="text-xs text-error">{actionErrors[e.id]}</p>}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </DashboardLayout>
  );
}
