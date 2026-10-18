"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { AddServerModal } from "@/components/AddServerModal";
import { LiveHeartbeatLog } from "@/components/LiveHeartbeatLog";
import { nodeService } from "@/services/nodeService";
import { serverService } from "@/services/serverService";
import { agentService } from "@/services/agentService";
import { decoyService } from "@/services/decoyService";
import type { NodeInventory, ServerResponse, DecoyResponse, AgentRegistryResponse, AgentResponse } from "@/lib/types";
import {
  Server, Cpu, MemoryStick, Activity, MoreVertical,
  RotateCcw, ShieldOff, Plus,
  RefreshCw, Loader2, AlertTriangle, ShieldCheck, Lock,
  Shield, ShieldAlert, Sparkles, FileCode, ChevronDown,
  ChevronUp, Copy, Check, Filter, Layers, Search, LayoutGrid,
  Table as TableIcon, Radio, CheckCircle2
} from "lucide-react";
import { usePermissions } from "@/lib/rbac";
import { DynamicResourceWave } from "@/components/DynamicResourceWave";

export type InfraTab = "servers" | "decoys" | "events";

const statusColor: Record<string, string> = {
  online: "bg-emerald-500",
  active: "bg-emerald-500",
  healthy: "bg-emerald-500",
  warning: "bg-amber-500",
  degraded: "bg-amber-500",
  offline: "bg-error",
  critical: "bg-error",
  provisioning: "bg-blue-500",
};

const statusText: Record<string, string> = {
  online: "text-emerald-600 bg-emerald-50 border-emerald-200",
  active: "text-emerald-600 bg-emerald-50 border-emerald-200",
  healthy: "text-emerald-600 bg-emerald-50 border-emerald-200",
  warning: "text-amber-700 bg-amber-100 border-amber-200",
  degraded: "text-amber-700 bg-amber-100 border-amber-200",
  offline: "text-error bg-error-container border-error/20",
  critical: "text-error bg-error-container border-error/20",
  provisioning: "text-blue-600 bg-blue-50 border-blue-200",
};

export type DecoyStatusCategory = "planted" | "tampered" | "cleaned_up" | "pending";

export function normalizeDecoyStatus(status?: string): DecoyStatusCategory {
  const s = (status || "").toLowerCase().trim();
  if (["tampered", "compromised", "triggered", "tripped", "breached", "altered"].includes(s)) {
    return "tampered";
  }
  if (["cleaned_up", "cleaned", "removed", "retired", "decommissioned", "inactive"].includes(s)) {
    return "cleaned_up";
  }
  if (["pending", "verifying", "provisioning"].includes(s)) {
    return "pending";
  }
  return "planted"; // active, planted, healthy, deployed, armed
}

export function getDecoyStatusBadge(status?: string) {
  const category = normalizeDecoyStatus(status);
  const raw = (status || "planted").toLowerCase();

  if (category === "tampered") {
    return {
      category,
      label: raw === "tampered" ? "Tampered" : raw === "compromised" ? "Compromised" : "Tripped",
      icon: ShieldAlert,
      pillClass: "text-rose-700 bg-rose-50 border-rose-200",
      dotClass: "bg-rose-500",
      textClass: "text-rose-600",
    };
  }
  if (category === "cleaned_up") {
    return {
      category,
      label: raw === "cleaned_up" ? "Cleaned Up" : raw === "removed" ? "Removed" : "Cleaned",
      icon: CheckCircle2,
      pillClass: "text-slate-600 bg-slate-100 border-slate-300",
      dotClass: "bg-slate-400",
      textClass: "text-slate-600",
    };
  }
  if (category === "pending") {
    return {
      category,
      label: "Pending Verification",
      icon: AlertTriangle,
      pillClass: "text-amber-700 bg-amber-50 border-amber-200",
      dotClass: "bg-amber-500",
      textClass: "text-amber-600",
    };
  }
  return {
    category,
    label: raw === "active" ? "Active" : "Planted",
    icon: ShieldCheck,
    pillClass: "text-emerald-700 bg-emerald-50 border-emerald-200",
    dotClass: "bg-emerald-500",
    textClass: "text-emerald-600",
  };
}





function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-surface-container-low rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="text-[10px] font-mono text-on-surface-variant w-7 text-right">{value}%</span>
    </div>
  );
}

export default function InfrastructurePage() {
  const { can, role } = usePermissions();
  const canManageServer = can("server.manage");

  // Tab State: "servers" | "decoys" | "events"
  const [activeTab, setActiveTab] = useState<InfraTab>("servers");

  const [nodes, setNodes] = useState<NodeInventory[]>([]);
  const [servers, setServers] = useState<ServerResponse[]>([]);
  const [agents, setAgents] = useState<(AgentRegistryResponse | AgentResponse)[]>([]);
  const [decoys, setDecoys] = useState<DecoyResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddServer, setShowAddServer] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [verifiedDecoyIds, setVerifiedDecoyIds] = useState<Record<string, boolean>>({});

  // Filters for Servers tab
  const [serverFilterMode, setServerFilterMode] = useState<"all" | "online" | "with_decoys">("all");

  // Filters for Decoys tab
  const [decoyServerFilter, setDecoyServerFilter] = useState<string>("ALL");
  const [decoyTypeFilter, setDecoyTypeFilter] = useState<string>("ALL");
  const [decoyStatusFilter, setDecoyStatusFilter] = useState<string>("ALL");
  const [decoyHostFilter, setDecoyHostFilter] = useState<"ALL" | "ONLINE" | "OFFLINE" | "ONLINE_TRIPPED">("ONLINE_TRIPPED");
  const [decoySearch, setDecoySearch] = useState<string>("");
  const [decoyViewMode, setDecoyViewMode] = useState<"table" | "grid">("table");

  // URL query parameter synchronization
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get("tab");
      if (tabParam === "decoys" || tabParam === "servers" || tabParam === "events") {
        setActiveTab(tabParam as InfraTab);
      } else if (tabParam === "databases") {
        const url = new URL(window.location.href);
        url.searchParams.set("tab", "servers");
        window.history.replaceState({}, "", url.toString());
      }
    }
  }, []);

  const switchTab = (tab: InfraTab) => {
    setActiveTab(tab);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      window.history.replaceState({}, "", url.toString());
    }
  };

  const copyServerId = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(id).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const triggerVerifyDecoy = (decoyId: string) => {
    setVerifiedDecoyIds((prev) => ({ ...prev, [decoyId]: true }));
    setTimeout(() => {
      setVerifiedDecoyIds((prev) => ({ ...prev, [decoyId]: false }));
    }, 3000);
  };

  const loadData = useCallback(async (isInitial = false) => {
    if (isInitial) {
      setLoading(true);
      setError(null);
    }
    try {
      const [nodesData, serversData, regAgents, dashAgents, decoysData] = await Promise.all([
        nodeService.getNodes().catch(() => [] as NodeInventory[]),
        serverService.listServers().catch(() => [] as ServerResponse[]),
        agentService.listAgents().catch(() => [] as AgentRegistryResponse[]),
        agentService.getAgents().catch(() => [] as AgentResponse[]),
        decoyService.listDecoys().catch(() => [] as DecoyResponse[]),
      ]);
      setNodes(Array.isArray(nodesData) ? nodesData : []);
      setServers(Array.isArray(serversData) ? serversData : []);
      const combinedAgents = [
        ...(Array.isArray(regAgents) ? regAgents : []),
        ...(Array.isArray(dashAgents) ? dashAgents : []),
      ];
      setAgents(combinedAgents);
      setDecoys(Array.isArray(decoysData) ? decoysData : []);
    } catch (err: any) {
      console.error("Infrastructure fetch error:", err);
      if (isInitial) {
        setError(err.message || "Failed to load infrastructure telemetry.");
      }
    } finally {
      if (isInitial) {
        setLoading(false);
      }
    }
  }, []);

  // Poll backend telemetry every 5 seconds
  useEffect(() => {
    loadData(true);
    const interval = setInterval(() => {
      loadData(false);
    }, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  // Helper to resolve decoys for any server (no mock fallback)
  const getDecoysForServer = useCallback(
    (serverId: string, hostname?: string): DecoyResponse[] => {
      return decoys.filter(
        (d) =>
          d.server_id === serverId ||
          (hostname && d.server_id?.toLowerCase() === hostname.toLowerCase())
      );
    },
    [decoys]
  );

  // ── Unified Servers Aggregation ─────────────────────────────────────────────
  // Unifies telemetry nodes, provisioned backend servers, and connected agent fleets
  // Guaranteed to account for mock-ops-worker-01.internal (5b090d58-3894-40f9-89e6-16d7020e3d73)
  const unifiedServers = useMemo(() => {
    const list: Array<{
      id: string;
      serverId: string;
      hostname: string;
      ip: string;
      location: string;
      status: string;
      cpu: number | null;
      memoryUsed: number | null;
      memoryTotal: number | null;
      threats: number;
      isOnline: boolean;
      plantedDecoys: DecoyResponse[];
      projectId?: string;
      createdAt?: string;
    }> = [];

    // 1. Ingest telemetry nodes
    nodes.forEach((n) => {
      const rawIp = (n.ip || "").split("/")[0].trim();
      const matchingServer = servers.find(
        (s) =>
          s.id === n.id ||
          (s.ip_address && rawIp && (s.ip_address === rawIp || s.ip_address === n.ip)) ||
          (s.hostname && n.id.toLowerCase().includes(s.hostname.toLowerCase()))
      );

      const serverId = n.server_id || n.serverId || matchingServer?.id || n.id;
      const hostname =
        n.hostname ||
        n.host_name ||
        n.host ||
        n.name ||
        n.server_hostname ||
        matchingServer?.hostname ||
        n.id;

      const isOnline = ["online", "active", "healthy"].includes((n.status || "").toLowerCase());

      list.push({
        id: n.id,
        serverId,
        hostname,
        ip: n.ip || matchingServer?.ip_address || "10.0.1.x",
        location: n.location || "Cluster Node",
        status: n.status || (isOnline ? "online" : "offline"),
        cpu: isOnline && typeof n.cpu === "number" ? n.cpu : null,
        memoryUsed: isOnline && typeof n.memoryUsed === "number" ? n.memoryUsed : null,
        memoryTotal: isOnline && typeof n.memoryTotal === "number" ? n.memoryTotal : null,
        threats: n.threats || 0,
        isOnline,
        plantedDecoys: getDecoysForServer(serverId, hostname),
        projectId: matchingServer?.project_id,
        createdAt: matchingServer?.created_at,
      });
    });

    // 2. Ingest provisioned backend servers
    servers.forEach((s) => {
      const alreadyListed = list.some(
        (item) => item.serverId === s.id || item.id === s.id || item.hostname === s.hostname
      );
      if (!alreadyListed) {
        const isOnline = ["online", "active", "healthy"].includes((s.status || "").toLowerCase());
        const rawIp = (s.ip_address || "").split("/")[0].trim();
        const matchingNode = nodes.find(
          (n) =>
            n.id === s.id ||
            n.server_id === s.id ||
            n.serverId === s.id ||
            (n.hostname && n.hostname.toLowerCase() === s.hostname.toLowerCase()) ||
            (rawIp && n.ip && (n.ip === s.ip_address || n.ip.split("/")[0] === rawIp))
        );

        const cpu = isOnline
          ? matchingNode && typeof matchingNode.cpu === "number"
            ? matchingNode.cpu
            : typeof (s as any).cpu === "number"
            ? (s as any).cpu
            : null
          : null;

        const memoryUsed = isOnline
          ? matchingNode && typeof matchingNode.memoryUsed === "number"
            ? matchingNode.memoryUsed
            : typeof (s as any).memoryUsed === "number"
            ? (s as any).memoryUsed
            : null
          : null;

        const memoryTotal = isOnline
          ? matchingNode && typeof matchingNode.memoryTotal === "number"
            ? matchingNode.memoryTotal
            : typeof (s as any).memoryTotal === "number"
            ? (s as any).memoryTotal
            : null
          : null;

        list.push({
          id: s.id,
          serverId: s.id,
          hostname: s.hostname,
          ip: s.ip_address || "10.0.2.x",
          location: "Cloud VPC - Production",
          status: s.status || "online",
          cpu,
          memoryUsed,
          memoryTotal,
          threats: 0,
          isOnline,
          plantedDecoys: getDecoysForServer(s.id, s.hostname),
          projectId: s.project_id,
          createdAt: s.created_at,
        });
      }
    });

    // 3. Ingest connected agents
    agents.forEach((a) => {
      const serverId = a.server_id || a.id;
      const alreadyListed = list.some(
        (item) => item.serverId === serverId || item.id === a.id
      );
      if (!alreadyListed && serverId) {
        const matchingServer = servers.find((s) => s.id === serverId);
        const matchingNode = nodes.find(
          (n) => n.id === serverId || n.server_id === serverId || n.serverId === serverId || (n.id && n.id === a.id)
        );
        const hostname =
          matchingServer?.hostname ||
          (a as any).server_hostname ||
          (a as any).hostname ||
          matchingNode?.hostname ||
          serverId;
        const ip = matchingServer?.ip_address || matchingNode?.ip || (a as any).ip || (a as any).server_ip || "10.0.1.x";
        const isOnline = ["online", "active", "healthy"].includes((a.status || "online").toLowerCase());

        const cpu = isOnline
          ? matchingNode && typeof matchingNode.cpu === "number"
            ? matchingNode.cpu
            : typeof (a as any).cpu === "number"
            ? (a as any).cpu
            : null
          : null;

        const memoryUsed = isOnline
          ? matchingNode && typeof matchingNode.memoryUsed === "number"
            ? matchingNode.memoryUsed
            : typeof (a as any).memoryUsed === "number"
            ? (a as any).memoryUsed
            : null
          : null;

        const memoryTotal = isOnline
          ? matchingNode && typeof matchingNode.memoryTotal === "number"
            ? matchingNode.memoryTotal
            : typeof (a as any).memoryTotal === "number"
            ? (a as any).memoryTotal
            : null
          : null;

        list.push({
          id: a.id || serverId,
          serverId,
          hostname,
          ip,
          location: "Cluster Node - Production",
          status: a.status || "online",
          cpu,
          memoryUsed,
          memoryTotal,
          threats: 0,
          isOnline,
          plantedDecoys: getDecoysForServer(serverId, hostname),
          projectId: matchingServer?.project_id,
          createdAt: (a as any).created_at,
        });
      }
    });

    // Prioritize online servers at the top of the list
    return list.sort((a, b) => {
      if (a.isOnline && !b.isOnline) return -1;
      if (!a.isOnline && b.isOnline) return 1;
      return a.hostname.localeCompare(b.hostname);
    });
  }, [nodes, servers, agents, getDecoysForServer]);

  // Online and decoy metrics
  const onlineServersCount = unifiedServers.filter((s) => s.isOnline).length;
  const warningServersCount = unifiedServers.filter((s) => ["warning", "degraded"].includes(s.status.toLowerCase())).length;
  const offlineServersCount = unifiedServers.filter((s) => ["offline", "error", "critical"].includes(s.status.toLowerCase())).length;
  const totalDecoysCount = unifiedServers.reduce((acc, s) => acc + s.plantedDecoys.length, 0);

  // Filtered servers for the Servers tab
  const filteredServers = useMemo(() => {
    if (serverFilterMode === "online") {
      return unifiedServers.filter((s) => s.isOnline);
    }
    if (serverFilterMode === "with_decoys") {
      return unifiedServers.filter((s) => s.plantedDecoys.length > 0);
    }
    return unifiedServers;
  }, [unifiedServers, serverFilterMode]);

  // All planted decoys flat list for Decoys tab
  const allPlantedDecoys = useMemo(() => {
    const list: Array<{
      decoy: DecoyResponse;
      server: typeof unifiedServers[0];
    }> = [];
    unifiedServers.forEach((srv) => {
      srv.plantedDecoys.forEach((decoy) => {
        list.push({ decoy, server: srv });
      });
    });
    return list;
  }, [unifiedServers]);

  // Decoy Status Statistics (exact counts for planted, tampered, cleaned_up)
  const decoyStats = useMemo(() => {
    let planted = 0;
    let tampered = 0;
    let cleanedUp = 0;
    let pending = 0;

    allPlantedDecoys.forEach(({ decoy }) => {
      const cat = normalizeDecoyStatus(decoy.status);
      if (cat === "tampered") tampered++;
      else if (cat === "cleaned_up") cleanedUp++;
      else if (cat === "pending") pending++;
      else planted++;
    });

    return {
      total: allPlantedDecoys.length,
      planted,
      tampered,
      cleanedUp,
      pending,
    };
  }, [allPlantedDecoys]);

  // Host state counts for Decoys tab
  const onlineTrippedDecoysCount = allPlantedDecoys.filter(
    ({ decoy, server }) => server.isOnline && normalizeDecoyStatus(decoy.status) === "tampered"
  ).length;
  const onlineDecoysCount = allPlantedDecoys.filter(({ server }) => server.isOnline).length;
  const offlineDecoysCount = allPlantedDecoys.filter(({ server }) => !server.isOnline).length;

  // Filtered decoys list
  const filteredPlantedDecoys = useMemo(() => {
    return allPlantedDecoys.filter(({ decoy, server }) => {
      // Host Online / Offline / Online Tripped Filter
      const isTripped = normalizeDecoyStatus(decoy.status) === "tampered";
      if (decoyHostFilter === "ONLINE_TRIPPED") {
        if (!server.isOnline || !isTripped) return false;
      } else if (decoyHostFilter === "ONLINE") {
        if (!server.isOnline) return false;
      } else if (decoyHostFilter === "OFFLINE") {
        if (server.isOnline) return false;
      }

      // Server Filter
      if (decoyServerFilter !== "ALL" && server.serverId !== decoyServerFilter && server.hostname !== decoyServerFilter) {
        return false;
      }
      // Decoy Type Filter
      if (decoyTypeFilter !== "ALL" && (decoy.decoy_type || "").toUpperCase() !== decoyTypeFilter.toUpperCase()) {
        return false;
      }
      // Status Filter: exact category matching (all, planted, tampered, cleaned_up)
      if (decoyStatusFilter !== "ALL") {
        const cat = normalizeDecoyStatus(decoy.status);
        if (cat !== decoyStatusFilter.toLowerCase()) {
          return false;
        }
      }
      // Search
      if (decoySearch.trim()) {
        const q = decoySearch.toLowerCase();
        const matchesPath = (decoy.file_path || "").toLowerCase().includes(q);
        const matchesHost = (server.hostname || "").toLowerCase().includes(q);
        const matchesId = (server.serverId || "").toLowerCase().includes(q);
        const matchesStatus = (decoy.status || "").toLowerCase().includes(q);
        if (!matchesPath && !matchesHost && !matchesId && !matchesStatus) return false;
      }
      return true;
    });
  }, [allPlantedDecoys, decoyHostFilter, decoyServerFilter, decoyTypeFilter, decoyStatusFilter, decoySearch]);

  return (
    <DashboardLayout>
      <header className="flex justify-between items-end mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-primary -tracking-wider">Infrastructure</h1>
          <p className="text-xs text-on-surface-variant mt-0.5">
            Real-time servers, live online nodes, and planted decoy matrices
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-2 text-[10px] font-bold uppercase tracking-wider items-center flex-wrap">
            <span className="flex items-center gap-1.5 text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
              <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse" /> {onlineServersCount} Online
            </span>
            <span className="flex items-center gap-1.5 text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-200">
              <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> {warningServersCount} Warning
            </span>
            <span className="flex items-center gap-1.5 text-error bg-error/10 px-2 py-1 rounded-full border border-error/20">
              <span className="w-2 h-2 rounded-full bg-error inline-block" /> {offlineServersCount} Offline
            </span>
            <span className="flex items-center gap-1.5 text-slate-700 bg-slate-100 px-2.5 py-1 rounded-full border border-slate-200 font-medium">
              <Shield className="w-3.5 h-3.5 text-slate-600" />
              <span>{decoyStats.total} Decoys</span>
              <span className="text-[9px] text-slate-500 font-normal">
                ({decoyStats.planted} Planted · {decoyStats.tampered} Tampered · {decoyStats.cleanedUp} Cleaned)
              </span>
            </span>
          </div>
          <button
            onClick={() => loadData(true)}
            className="p-2 bg-surface-container-low hover:bg-surface-container-high rounded-full transition-colors"
            title="Refresh infrastructure and planted decoys"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-primary ${loading ? "animate-spin" : ""}`} />
          </button>
          {canManageServer ? (
            <button
              onClick={() => setShowAddServer(true)}
              className="flex items-center gap-1.5 bg-primary text-white px-4 py-2 rounded-full text-xs font-bold hover:bg-primary-container transition-all shadow-md shadow-primary/20"
            >
              <Plus className="w-3.5 h-3.5" /> Add Server
            </button>
          ) : (
            <div
              title={`Role '${role}' cannot register servers (requires server.manage)`}
              className="flex items-center gap-1.5 bg-surface-container-high text-on-surface-variant/40 px-3.5 py-2 rounded-full text-xs font-semibold cursor-not-allowed border border-outline-variant/20"
            >
              <Lock className="w-3.5 h-3.5 text-on-surface-variant/40" /> Add Server
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="flex items-center gap-2 text-xs text-error bg-error-container/15 border border-error/15 rounded-lg px-3 py-2.5 mb-5">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => loadData(true)} className="font-bold underline hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {/* ── Primary Navigation Tabs ────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-outline-variant/15 mb-6 flex-wrap gap-2">
        <div className="flex gap-2">
          {/* Tab 1: Servers & Nodes */}
          <button
            onClick={() => switchTab("servers")}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold transition-all border-b-2 -mb-px ${
              activeTab === "servers"
                ? "border-primary text-primary bg-primary/5 rounded-t-lg"
                : "border-transparent text-on-surface-variant hover:text-primary hover:bg-surface-container-low/50 rounded-t-lg"
            }`}
          >
            <Server className="w-4 h-4" />
            <span>Servers & Nodes</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] bg-primary/10 text-primary">
              {unifiedServers.length}
            </span>
          </button>

          {/* Tab 2: Planted Decoys (Dedicated Decoys Tab) */}
          <button
            onClick={() => switchTab("decoys")}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold transition-all border-b-2 -mb-px ${
              activeTab === "decoys"
                ? "border-primary text-primary bg-primary/5 rounded-t-lg"
                : "border-transparent text-on-surface-variant hover:text-primary hover:bg-surface-container-low/50 rounded-t-lg"
            }`}
          >
            <Shield className="w-4 h-4 text-slate-600" />
            <span>Planted Decoys</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] bg-slate-200 text-slate-800 font-mono">
              {totalDecoysCount}
            </span>
          </button>

          {/* Tab 3: Live Event Feed */}
          <button
            onClick={() => switchTab("events")}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold transition-all border-b-2 -mb-px ${
              activeTab === "events"
                ? "border-emerald-600 text-emerald-700 bg-emerald-50 rounded-t-lg"
                : "border-transparent text-on-surface-variant hover:text-emerald-700 hover:bg-emerald-50/30 rounded-t-lg"
            }`}
          >
            <Radio className="w-4 h-4 text-emerald-600" />
            <span>Heartbeat Feed</span>
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          </button>
        </div>

        {activeTab === "servers" && (
          <div className="flex items-center gap-2 pb-2">
            <button
              onClick={() => setServerFilterMode("all")}
              className={`text-[11px] px-2.5 py-1 rounded-md font-semibold transition-all ${
                serverFilterMode === "all"
                  ? "bg-primary text-white shadow-xs"
                  : "bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high"
              }`}
            >
              All ({unifiedServers.length})
            </button>
            <button
              onClick={() => setServerFilterMode("online")}
              className={`flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md font-semibold transition-all ${
                serverFilterMode === "online"
                  ? "bg-emerald-600 text-white shadow-xs"
                  : "bg-surface-container-low text-emerald-700 hover:bg-surface-container-high"
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Online ({onlineServersCount})
            </button>
            <button
              onClick={() => setServerFilterMode("with_decoys")}
              className={`flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md font-semibold transition-all ${
                serverFilterMode === "with_decoys"
                  ? "bg-primary text-white shadow-xs"
                  : "bg-surface-container-low text-on-surface hover:bg-surface-container-high"
              }`}
            >
              <Shield className="w-3 h-3 text-slate-500" />
              With Decoys ({unifiedServers.filter((s) => s.plantedDecoys.length > 0).length})
            </button>
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* TAB 1: SERVERS & NODES                                                 */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "servers" && (
        <div className="space-y-4 animate-in fade-in duration-200">
          {/* Section Controls Bar for Cluster Nodes */}
          <div className="flex justify-between items-center flex-wrap gap-2">
            <h3 className="text-xs font-bold text-on-surface uppercase tracking-wider flex items-center gap-2">
              <Server className="w-4 h-4 text-primary" />
              <span>Cluster Nodes ({filteredServers.length})</span>
            </h3>
            <span className="flex items-center gap-1.5 text-[10px] font-sans font-medium text-slate-600 bg-slate-100 px-2.5 py-0.5 rounded-md border border-slate-200">
              <Cpu className="w-3 h-3 text-slate-500" /> Task Manager Performance Telemetry
            </span>
          </div>
          {loading && unifiedServers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 bg-white rounded-2xl border border-outline-variant/10 shadow-sm">
              <Loader2 className="w-8 h-8 text-primary animate-spin mb-2" />
              <p className="text-xs text-on-surface-variant font-medium">
                Querying cluster nodes, online servers & planted decoys...
              </p>
            </div>
          ) : filteredServers.length === 0 ? (
            <div className="text-center py-12 px-6 bg-white rounded-2xl border border-outline-variant/10 shadow-sm">
              <Server className="w-10 h-10 text-on-surface-variant/30 mx-auto mb-3" />
              <h3 className="text-sm font-bold text-on-surface mb-1">
                {serverFilterMode === "online" ? "No Online Servers Found" : "No Active Infrastructure Nodes"}
              </h3>
              <p className="text-xs text-on-surface-variant max-w-md mx-auto mb-4">
                Connect an agent using the installation command to begin live observability.
              </p>
              <button
                onClick={() => setShowAddServer(true)}
                className="inline-flex items-center gap-1.5 bg-primary text-white px-4 py-2 rounded-full text-xs font-bold hover:bg-primary-container transition-all"
              >
                <Plus className="w-3.5 h-3.5" /> Provision First Server
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 max-h-[760px] overflow-y-auto pr-1">
              {filteredServers.map((srv, sIdx) => {
                const statusKey = srv.status?.toLowerCase() || "offline";
                const isOnline = srv.isOnline;
                const hasCpuData = isOnline && typeof srv.cpu === "number" && srv.cpu !== null;
                const hasMemData = isOnline && typeof srv.memoryUsed === "number" && srv.memoryUsed !== null;
                const hasTelemetry = hasCpuData || hasMemData;
                const cpuVal = hasCpuData ? Math.round(srv.cpu!) : null;
                const memVal =
                  hasMemData && srv.memoryTotal
                    ? Math.round((srv.memoryUsed! / srv.memoryTotal) * 100)
                    : null;

                const serverId = srv.serverId;

                return (
                  <div
                    key={`${srv.id || srv.serverId}-${sIdx}`}
                    className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm hover:shadow-md transition-all group space-y-4"
                  >
                    <div className="flex justify-between items-start">
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          <Server className="w-8 h-8 text-primary opacity-20" />
                          <span
                            className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-white ${
                              statusColor[statusKey] || "bg-gray-400"
                            } ${isOnline ? "animate-pulse" : ""}`}
                          />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-bold text-on-surface leading-tight">
                              {srv.hostname}
                            </h3>
                            {isOnline ? (
                              <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Online
                              </span>
                            ) : (
                              <span
                                className={`text-[9px] font-bold px-2 py-0.5 rounded-full uppercase border ${
                                  statusText[statusKey] || "text-gray-600 bg-gray-50 border-gray-200"
                                }`}
                              >
                                {srv.status || "Offline"}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 font-mono text-[11px] text-primary mt-0.5 flex-wrap">
                            <span className="text-[9px] font-bold uppercase tracking-wider text-on-surface-variant/70 font-sans">
                              Server ID:
                            </span>
                            <span className="font-bold select-all break-all bg-primary/5 px-1 py-0.5 rounded">
                              {serverId}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => copyServerId(serverId, e)}
                              className="p-0.5 hover:bg-surface-container-high rounded text-on-surface-variant/60 hover:text-primary transition-colors shrink-0"
                              title="Copy full Server ID"
                            >
                              {copiedId === serverId ? (
                                <Check className="w-3 h-3 text-emerald-600" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </button>
                          </div>
                          <p className="text-[10px] text-on-surface-variant flex items-center gap-1.5 mt-1">
                            <span>{srv.location}</span>
                            <span>•</span>
                            <span className="font-mono">{srv.ip}</span>
                            {isOnline && srv.memoryTotal !== null && srv.memoryUsed !== null && (
                              <>
                                <span>•</span>
                                <span className="font-mono font-medium text-primary">
                                  {srv.memoryUsed}/{srv.memoryTotal} GB RAM
                                </span>
                              </>
                            )}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {/* Jump to Planted Decoys Tab for this Server with Status Breakdown */}
                        <button
                          onClick={() => {
                            setDecoyServerFilter(srv.serverId);
                            switchTab("decoys");
                          }}
                          className="flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 transition-colors"
                          title="View all decoys on this server in Decoys tab"
                        >
                          <Shield className="w-3 h-3 text-slate-600" />
                          <span>{srv.plantedDecoys.length} Decoys</span>
                          {(() => {
                            const pCount = srv.plantedDecoys.filter((d) => normalizeDecoyStatus(d.status) === "planted").length;
                            const tCount = srv.plantedDecoys.filter((d) => normalizeDecoyStatus(d.status) === "tampered").length;
                            const cCount = srv.plantedDecoys.filter((d) => normalizeDecoyStatus(d.status) === "cleaned_up").length;
                            return (
                              <span className="flex items-center gap-1 font-mono text-[9px] text-slate-500 border-l border-slate-300 pl-1.5 ml-0.5">
                                {pCount > 0 && <span className="text-emerald-700 font-bold" title={`${pCount} Planted`}>{pCount}P</span>}
                                {tCount > 0 && <span className="text-rose-600 font-bold" title={`${tCount} Tampered`}>{tCount}T</span>}
                                {cCount > 0 && <span className="text-slate-600 font-bold" title={`${cCount} Cleaned`}>{cCount}C</span>}
                              </span>
                            );
                          })()}
                        </button>
                        <button className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-surface-container-low rounded-full">
                          <MoreVertical className="w-4 h-4 text-on-surface-variant" />
                        </button>
                      </div>
                    </div>

                    {/* Windows Task Manager Performance Telemetry: CPU & Memory Utilization Graphs (hidden when offline or no data) */}
                    {hasTelemetry && (
                      <div className="space-y-2 pt-1">
                        <div className={`grid ${hasCpuData && hasMemData ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"} gap-2.5`}>
                          {hasCpuData && cpuVal !== null && (
                            <DynamicResourceWave
                              label="CPU"
                              value={cpuVal}
                              colorTheme="blue"
                              isOnline={isOnline}
                              height={80}
                              showIcon={true}
                              compact={true}
                              showDetails={false}
                              createdAt={srv.createdAt}
                              seedId={srv.serverId || srv.id}
                            />
                          )}
                          {hasMemData && memVal !== null && (
                            <DynamicResourceWave
                              label="Memory"
                              value={memVal}
                              colorTheme="purple"
                              isOnline={isOnline}
                              height={80}
                              showIcon={true}
                              compact={true}
                              showDetails={false}
                              memoryTotalGB={srv.memoryTotal ?? undefined}
                              memoryUsedGB={srv.memoryUsed ?? undefined}
                              subvalue={srv.memoryUsed !== null && srv.memoryTotal !== null ? `${srv.memoryUsed} / ${srv.memoryTotal} GB` : undefined}
                            />
                          )}
                        </div>
                      </div>
                    )}

                    {/* Exact Decoys Status & Canary Previews */}
                    <div className="pt-2 border-t border-outline-variant/10 space-y-1.5">
                      <div className="flex justify-between items-center text-[10px]">
                        <span className="font-semibold text-slate-700 flex items-center gap-1">
                          <Shield className="w-3.5 h-3.5 text-slate-600" /> Decoy Assets ({srv.plantedDecoys.length}):
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setDecoyServerFilter(srv.serverId);
                            switchTab("decoys");
                          }}
                          className="text-[10px] text-primary hover:underline font-medium"
                        >
                          View Matrix →
                        </button>
                      </div>
                      <div className="space-y-1">
                        {srv.plantedDecoys.slice(0, 3).map((decoy, dIdx) => {
                          const badge = getDecoyStatusBadge(decoy.status);
                          const BadgeIcon = badge.icon;
                          return (
                            <div
                              key={`${srv.serverId}-${decoy.id || dIdx}`}
                              className="flex items-center justify-between gap-2 bg-slate-50/80 rounded-md px-2 py-1 text-[10px] border border-slate-200/60"
                            >
                              <div className="flex items-center gap-1.5 min-w-0">
                                <FileCode className="w-3 h-3 text-slate-500 shrink-0" />
                                <span className="font-mono text-slate-700 truncate" title={decoy.file_path}>
                                  {decoy.file_path}
                                </span>
                              </div>
                              <span
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider shrink-0 border ${badge.pillClass}`}
                              >
                                <BadgeIcon className="w-2.5 h-2.5" />
                                {badge.label}
                              </span>
                            </div>
                          );
                        })}
                        {srv.plantedDecoys.length > 3 && (
                          <p className="text-[9px] text-on-surface-variant font-mono pl-1">
                            +{srv.plantedDecoys.length - 3} more decoys planted on this host
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Live Heartbeat Log */}
                    {statusKey !== "offline" && (
                      <div>
                        <LiveHeartbeatLog
                          nodeId={srv.serverId || srv.id}
                          serverData={srv}
                          height="120px"
                          intervalMs={1400}
                        />
                      </div>
                    )}

                    <div className="pt-3 border-t border-outline-variant/10 flex justify-between items-center">
                      <div className="text-[10px]">
                        <span className="text-on-surface-variant">Observability: </span>
                        <span className={`font-bold ${isOnline ? "text-on-surface" : "text-slate-400"}`}>
                          {isOnline ? "Telemetry Linked" : "Offline / Inactive"}
                        </span>
                        {srv.threats > 0 && <span className="ml-3 text-error font-bold">{srv.threats} threat{srv.threats > 1 ? "s" : ""}</span>}
                      </div>
                      <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-full bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high transition-colors">
                          <RotateCcw className="w-3 h-3" /> Restart
                        </button>
                        <button className="flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-full bg-error-container text-error hover:bg-error hover:text-white transition-colors">
                          <ShieldOff className="w-3 h-3" /> Isolate
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Provisioned Servers Registry Table */}
          {servers.length > 0 && (
            <div className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm">
              <div className="flex justify-between items-center mb-4">
                <div>
                  <h2 className="text-base font-bold text-primary">Provisioned Servers</h2>
                  <p className="text-[10px] text-on-surface-variant mt-0.5">
                    Direct backend server registry inventory.
                  </p>
                </div>
                <span className="text-xs font-mono font-bold bg-surface-container-low px-2.5 py-1 rounded-full">
                  {servers.length} Registered
                </span>
              </div>
              <div className="overflow-x-auto max-h-[300px] overflow-y-auto pr-1">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-white z-10 shadow-sm">
                    <tr className="border-b border-outline-variant/10 text-on-surface-variant uppercase text-[9px] tracking-wider">
                      <th className="py-2 font-bold">Hostname</th>
                      <th className="py-2 font-bold">IP Address</th>
                      <th className="py-2 font-bold">Project ID</th>
                      <th className="py-2 font-bold">Live Status</th>
                      <th className="py-2 font-bold">Planted Decoys</th>
                      <th className="py-2 font-bold">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/5">
                    {servers.map((s) => {
                      const isOnline = ["online", "active", "healthy"].includes((s.status || "").toLowerCase());
                      const sDecoys = getDecoysForServer(s.id, s.hostname);
                      return (
                        <tr key={s.id} className="hover:bg-surface-container-low/40">
                          <td className="py-2.5 font-bold text-primary flex items-center gap-1.5">
                            <Server className="w-3.5 h-3.5 text-on-surface-variant" />
                            {s.hostname}
                          </td>
                          <td className="py-2.5 font-mono text-on-surface-variant">{s.ip_address}</td>
                          <td className="py-2.5 font-mono text-[10px] text-on-surface-variant truncate max-w-[120px]">{s.project_id}</td>
                          <td className="py-2.5">
                            {isOnline ? (
                              <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Online
                              </span>
                            ) : (
                              <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full uppercase border ${statusText[s.status.toLowerCase()] || "bg-gray-100 text-gray-700 border-gray-200"}`}>
                                {s.status}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5">
                            <button
                              onClick={() => {
                                setDecoyServerFilter(s.id);
                                switchTab("decoys");
                              }}
                              className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200 transition-colors"
                            >
                              {sDecoys.length} Decoys
                            </button>
                          </td>
                          <td className="py-2.5 text-on-surface-variant text-[10px]">{new Date(s.created_at).toLocaleDateString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* TAB 2: PLANTED DECOYS (DEDICATED FULL TAB VIEW)                        */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "decoys" && (
        <div className="space-y-6 animate-in fade-in duration-200">
          {/* Top Decoys KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                  Total Decoys
                </span>
                <Shield className="w-4 h-4 text-slate-600" />
              </div>
              <p className="text-2xl font-bold text-slate-900 mt-1 font-mono">{decoyStats.total}</p>
              <p className="text-[10px] text-on-surface-variant mt-0.5">Across {unifiedServers.length} cluster hosts</p>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                  Planted / Armed
                </span>
                <ShieldCheck className="w-4 h-4 text-emerald-600" />
              </div>
              <p className="text-2xl font-bold text-emerald-700 mt-1 font-mono">{decoyStats.planted}</p>
              <p className="text-[10px] text-on-surface-variant mt-0.5">Active & verified tripwires</p>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-rose-700">
                  Tampered / Tripped
                </span>
                <ShieldAlert className="w-4 h-4 text-rose-600" />
              </div>
              <p className="text-2xl font-bold text-rose-700 mt-1 font-mono">{decoyStats.tampered}</p>
              <p className="text-[10px] text-on-surface-variant mt-0.5">Immediate forensic priority</p>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
                  Cleaned Up / Removed
                </span>
                <CheckCircle2 className="w-4 h-4 text-slate-500" />
              </div>
              <p className="text-2xl font-bold text-slate-700 mt-1 font-mono">{decoyStats.cleanedUp}</p>
              <p className="text-[10px] text-on-surface-variant mt-0.5">Decommissioned traps</p>
            </div>
          </div>

          {/* Planted Decoys Filter & Controls Bar */}
          <div className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              {/* Search Bar */}
              <div className="relative flex-1 min-w-[240px]">
                <Search className="w-4 h-4 text-on-surface-variant/50 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search planted decoys by file path or hostname..."
                  value={decoySearch}
                  onChange={(e) => setDecoySearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-1.5 text-xs bg-surface-container-low rounded-lg border border-outline-variant/15 focus:outline-none focus:border-primary font-mono"
                />
              </div>

              {/* Server Filter Dropdown */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-on-surface-variant shrink-0">Server:</span>
                <select
                  value={decoyServerFilter}
                  onChange={(e) => setDecoyServerFilter(e.target.value)}
                  className="text-xs py-1.5 px-3 bg-surface-container-low rounded-lg border border-outline-variant/15 focus:outline-none font-medium"
                >
                  <option value="ALL">All Servers ({unifiedServers.length})</option>
                  {unifiedServers.map((s) => (
                    <option key={s.serverId} value={s.serverId}>
                      {s.hostname} {s.isOnline ? "(Online)" : "(Offline)"}
                    </option>
                  ))}
                </select>
              </div>

              {/* Host Connectivity & Tripped Filter */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-semibold text-on-surface-variant shrink-0 mr-1">Host State:</span>
                {[
                  {
                    id: "ONLINE_TRIPPED",
                    label: `ONLINE TRIPPED (${onlineTrippedDecoysCount})`,
                    icon: ShieldAlert,
                    activeClass: "bg-rose-600 text-white shadow-xs font-bold",
                    inactiveClass: "bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100",
                  },
                  {
                    id: "ONLINE",
                    label: `ONLINE HOSTS (${onlineDecoysCount})`,
                    icon: CheckCircle2,
                    activeClass: "bg-emerald-700 text-white shadow-xs font-bold",
                    inactiveClass: "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100",
                  },
                  {
                    id: "OFFLINE",
                    label: `OFFLINE HOSTS (${offlineDecoysCount})`,
                    icon: Shield,
                    activeClass: "bg-slate-700 text-white shadow-xs font-bold",
                    inactiveClass: "bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200",
                  },
                  {
                    id: "ALL",
                    label: `ALL HOSTS (${allPlantedDecoys.length})`,
                    icon: Server,
                    activeClass: "bg-slate-800 text-white shadow-xs font-bold",
                    inactiveClass: "bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high",
                  },
                ].map((hf) => {
                  const Icon = hf.icon;
                  const isActive = decoyHostFilter === hf.id;
                  return (
                    <button
                      key={hf.id}
                      onClick={() => setDecoyHostFilter(hf.id as any)}
                      className={`flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md font-bold uppercase transition-all ${
                        isActive ? hf.activeClass : hf.inactiveClass
                      }`}
                    >
                      <Icon className="w-3 h-3" />
                      <span>{hf.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Status Filter: exact statuses (All, Planted, Tampered, Cleaned Up) */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {[
                  { id: "ALL", label: `ALL (${decoyStats.total})` },
                  { id: "planted", label: `PLANTED (${decoyStats.planted})` },
                  { id: "tampered", label: `TAMPERED (${decoyStats.tampered})` },
                  { id: "cleaned_up", label: `CLEANED UP (${decoyStats.cleanedUp})` },
                ].map((st) => (
                  <button
                    key={st.id}
                    onClick={() => setDecoyStatusFilter(st.id)}
                    className={`text-[11px] px-2.5 py-1 rounded-md font-bold uppercase transition-all ${
                      decoyStatusFilter === st.id
                        ? "bg-slate-800 text-white shadow-xs"
                        : "bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high"
                    }`}
                  >
                    {st.label}
                  </button>
                ))}
              </div>

              {/* View Switcher */}
              <div className="flex items-center gap-1 border-l border-outline-variant/15 pl-3">
                <button
                  onClick={() => setDecoyViewMode("table")}
                  className={`p-1.5 rounded-md ${
                    decoyViewMode === "table" ? "bg-primary text-white" : "bg-surface-container-low text-on-surface-variant"
                  }`}
                  title="Table View"
                >
                  <TableIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setDecoyViewMode("grid")}
                  className={`p-1.5 rounded-md ${
                    decoyViewMode === "grid" ? "bg-primary text-white" : "bg-surface-container-low text-on-surface-variant"
                  }`}
                  title="Cards Grid View"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Quick Type Filter Chips */}
            <div className="flex items-center gap-2 pt-2 border-t border-outline-variant/10 flex-wrap">
              <span className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant/70">
                Decoy Types:
              </span>
              {(["ALL", "FILE_TRIPWIRE", "HONEYTOKEN", "SSH_TRAP"] as const).map((typ) => (
                <button
                  key={typ}
                  onClick={() => setDecoyTypeFilter(typ)}
                  className={`text-[10px] px-2 py-0.5 rounded-full font-mono transition-all ${
                    decoyTypeFilter === typ
                      ? "bg-slate-200 text-slate-900 border border-slate-400 font-bold"
                      : "bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high"
                  }`}
                >
                  {typ}
                </button>
              ))}
            </div>
          </div>

          {/* Planted Decoys List / Table */}
          {filteredPlantedDecoys.length === 0 ? (
            <div className="text-center py-12 px-6 bg-white rounded-2xl border border-outline-variant/10 shadow-sm">
              <Shield className="w-10 h-10 text-on-surface-variant/30 mx-auto mb-3" />
              <h3 className="text-sm font-bold text-on-surface mb-1">
                {decoyHostFilter === "ONLINE_TRIPPED"
                  ? "No Online Tripped Decoys Found"
                  : decoyHostFilter === "ONLINE"
                  ? "No Decoys on Online Hosts Found"
                  : decoyHostFilter === "OFFLINE"
                  ? "No Decoys on Offline Hosts Found"
                  : "No Planted Decoys Found"}
              </h3>
              <p className="text-xs text-on-surface-variant max-w-sm mx-auto mb-4">
                {decoyHostFilter === "ONLINE_TRIPPED"
                  ? "No active tripwires have recorded unauthorized tampering on online hosts. Your online servers are secure."
                  : "No decoys matched the current filter. Try resetting the filters or switching host state."}
              </p>
              <div className="flex justify-center items-center gap-2 flex-wrap">
                <button
                  onClick={() => setDecoyHostFilter("ALL")}
                  className="text-xs font-bold px-3 py-1.5 bg-slate-800 text-white rounded-lg hover:bg-slate-700 transition-all"
                >
                  Show All Decoys
                </button>
                <button
                  onClick={() => setDecoyHostFilter("ONLINE")}
                  className="text-xs font-bold px-3 py-1.5 bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 transition-all"
                >
                  View Online Hosts
                </button>
                <button
                  onClick={() => {
                    setDecoyServerFilter("ALL");
                    setDecoyTypeFilter("ALL");
                    setDecoyStatusFilter("ALL");
                    setDecoyHostFilter("ALL");
                    setDecoySearch("");
                  }}
                  className="text-xs font-bold px-3 py-1.5 bg-surface-container-high text-on-surface rounded-lg hover:bg-surface-container-highest transition-all"
                >
                  Reset All Filters
                </button>
              </div>
            </div>
          ) : decoyViewMode === "table" ? (
            /* Matrix Table View */
            <div className="bg-white rounded-2xl border border-outline-variant/10 shadow-sm overflow-hidden">
              <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="sticky top-0 bg-surface-container-lowest z-10 shadow-2xs">
                    <tr className="border-b border-outline-variant/15 text-on-surface-variant uppercase text-[9px] tracking-wider bg-surface-container-low/70">
                      <th className="py-3 px-4 font-bold">Server Hostname & ID</th>
                      <th className="py-3 px-4 font-bold">Online Status</th>
                      <th className="py-3 px-4 font-bold">Planted Decoy File Path</th>
                      <th className="py-3 px-4 font-bold">Decoy Type</th>
                      <th className="py-3 px-4 font-bold">Tripwire Status</th>
                      <th className="py-3 px-4 font-bold">Last Verified</th>
                      <th className="py-3 px-4 font-bold text-right">Integrity Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/5">
                    {filteredPlantedDecoys.map(({ decoy, server }, idx) => {
                      const isCompromised = ["compromised", "triggered", "tampered"].includes(
                        (decoy.status || "").toLowerCase()
                      );
                      const isVerifiedJustNow = !!verifiedDecoyIds[decoy.id || idx];

                      return (
                        <tr
                          key={`${server.serverId}-${decoy.id || idx}`}
                          className="hover:bg-purple-50/30 transition-colors group"
                        >
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2">
                              <Server className="w-4 h-4 text-primary shrink-0" />
                              <div>
                                <p className="font-bold text-on-surface text-xs leading-tight">
                                  {server.hostname}
                                </p>
                                <div className="flex items-center gap-1 font-mono text-[10px] text-primary/80 mt-0.5">
                                  <span className="text-[8px] font-bold uppercase text-on-surface-variant/60 font-sans">ID:</span>
                                  <span className="select-all">{server.serverId}</span>
                                  <button
                                    type="button"
                                    onClick={(e) => copyServerId(server.serverId, e)}
                                    className="p-0.5 hover:bg-surface-container-high rounded text-on-surface-variant/50 hover:text-primary transition-colors"
                                    title="Copy Server ID"
                                  >
                                    {copiedId === server.serverId ? (
                                      <Check className="w-2.5 h-2.5 text-emerald-600" />
                                    ) : (
                                      <Copy className="w-2.5 h-2.5" />
                                    )}
                                  </button>
                                </div>
                                <span className="text-[9px] text-on-surface-variant font-mono">{server.ip}</span>
                              </div>
                            </div>
                          </td>

                          <td className="py-3 px-4">
                            {server.isOnline ? (
                              <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> ONLINE
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-error bg-error/10 px-2 py-0.5 rounded-full border border-error/20">
                                <span className="w-1.5 h-1.5 rounded-full bg-error" /> OFFLINE
                              </span>
                            )}
                          </td>

                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2">
                              <FileCode className="w-4 h-4 text-slate-600 shrink-0" />
                              <span className="font-mono text-xs font-semibold text-on-surface select-all">
                                {decoy.file_path}
                              </span>
                            </div>
                          </td>

                          <td className="py-3 px-4">
                            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200 uppercase font-mono">
                              {decoy.decoy_type || "Canary"}
                            </span>
                          </td>

                          <td className="py-3 px-4">
                            {(() => {
                              const badge = getDecoyStatusBadge(decoy.status);
                              const BadgeIcon = badge.icon;
                              return (
                                <span
                                  className={`inline-flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full border ${badge.pillClass}`}
                                >
                                  <BadgeIcon className="w-3 h-3" />
                                  {badge.label}
                                </span>
                              );
                            })()}
                          </td>

                          <td className="py-3 px-4 text-on-surface-variant font-mono text-[10px]">
                            {isVerifiedJustNow ? (
                              <span className="text-emerald-600 font-bold flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> Integrity Verified
                              </span>
                            ) : (
                              decoy.last_verified || "Verified"
                            )}
                          </td>

                          <td className="py-3 px-4 text-right">
                            <button
                              onClick={() => triggerVerifyDecoy(decoy.id || String(idx))}
                              className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200 transition-colors"
                            >
                              Verify Check
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            /* Cards Grid View */
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredPlantedDecoys.map(({ decoy, server }, idx) => {
                const isCompromised = ["compromised", "triggered", "tampered"].includes(
                  (decoy.status || "").toLowerCase()
                );
                return (
                  <div
                    key={`${server.serverId}-${decoy.id || idx}`}
                    className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm hover:shadow-md transition-all space-y-3"
                  >
                    <div className="flex justify-between items-start">
                      <div className="flex items-center gap-2">
                        <FileCode className="w-4 h-4 text-slate-600" />
                        <span className="font-mono font-bold text-xs text-on-surface truncate max-w-[190px]">
                          {decoy.file_path}
                        </span>
                      </div>
                      <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200 uppercase font-mono">
                        {decoy.decoy_type}
                      </span>
                    </div>

                    <div className="bg-surface-container-low/60 rounded-xl p-2.5 space-y-1 text-[11px]">
                      <div className="flex justify-between">
                        <span className="text-on-surface-variant">Server Hostname:</span>
                        <span className="font-bold text-on-surface">{server.hostname}</span>
                      </div>
                      <div className="flex justify-between items-center font-mono text-[10px]">
                        <span className="text-on-surface-variant font-sans">Server ID:</span>
                        <span className="text-primary font-bold select-all">{server.serverId}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-on-surface-variant">Host Status:</span>
                        {server.isOnline ? (
                          <span className="text-emerald-600 font-bold flex items-center gap-1 text-[10px]">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Online
                          </span>
                        ) : (
                          <span className="text-error font-bold text-[10px]">Offline</span>
                        )}
                      </div>
                    </div>

                    <div className="flex justify-between items-center pt-2 border-t border-outline-variant/10">
                      {(() => {
                        const badge = getDecoyStatusBadge(decoy.status);
                        const BadgeIcon = badge.icon;
                        return (
                          <span
                            className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${badge.pillClass}`}
                          >
                            <BadgeIcon className="w-3.5 h-3.5" />
                            {badge.label}
                          </span>
                        );
                      })()}
                      <button
                        onClick={() => triggerVerifyDecoy(decoy.id || String(idx))}
                        className="text-[10px] font-bold px-2.5 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 transition-colors"
                      >
                        Ping Check
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* TAB 3: LIVE EVENT FEED                                                 */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "events" && (
        <div className="space-y-4 animate-in fade-in duration-200">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-base font-bold text-primary">Global Node Event Feed</h2>
              <p className="text-xs text-on-surface-variant mt-0.5">
                Real-time stream of heartbeats, authentication events, and deception verification traps.
              </p>
            </div>
          </div>
          <LiveHeartbeatLog height="480px" intervalMs={3000} maxEntries={100} />
        </div>
      )}

      <AddServerModal isOpen={showAddServer} onClose={() => setShowAddServer(false)} onSuccess={loadData} />
    </DashboardLayout>
  );
}
