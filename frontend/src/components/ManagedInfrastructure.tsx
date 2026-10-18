"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Server, Grid, List, MoreVertical, RefreshCw, Loader2,
  Copy, Check, Shield, ChevronDown, ChevronUp, FileCode,
  ShieldCheck, ShieldAlert, Sparkles, Activity, CheckCircle2, AlertTriangle
} from "lucide-react";
import { nodeService } from "@/services/nodeService";
import { serverService } from "@/services/serverService";
import { agentService } from "@/services/agentService";
import { decoyService } from "@/services/decoyService";
import type { NodeInventory, ServerResponse, DecoyResponse, AgentRegistryResponse, AgentResponse } from "@/lib/types";
import { DynamicResourceWave } from "@/components/DynamicResourceWave";

function statusColor(status: string) {
  const s = (status || "").toLowerCase();
  if (s === "online" || s === "active" || s === "healthy") return "bg-emerald-500";
  if (s === "warning" || s === "degraded") return "bg-amber-500";
  if (s === "offline" || s === "error" || s === "critical") return "bg-red-500";
  return "bg-gray-400";
}

function statusBadge(status: string) {
  const s = (status || "").toLowerCase();
  if (s === "online" || s === "active" || s === "healthy") {
    return (
      <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Agent Online
      </span>
    );
  }
  if (s === "warning" || s === "degraded") {
    return (
      <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Warning
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-error bg-error/10 px-2 py-0.5 rounded-full border border-error/20">
      <span className="w-1.5 h-1.5 rounded-full bg-error" /> Offline
    </span>
  );
}

function cpuColor(cpu: number | null) {
  if (cpu === null) return "text-on-surface-variant";
  if (cpu > 80) return "text-error";
  if (cpu > 50) return "text-amber-600";
  return "text-primary";
}

function formatCpu(cpu: number | null): string {
  if (cpu === null) return "N/A";
  if (typeof cpu === "number") {
    return `${Number.isInteger(cpu) ? cpu : cpu.toFixed(1)}%`;
  }
  return `${cpu}%`;
}

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
  return "planted";
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





export function ManagedInfrastructure() {
  const [nodes, setNodes] = useState<NodeInventory[]>([]);
  const [servers, setServers] = useState<ServerResponse[]>([]);
  const [agents, setAgents] = useState<(AgentRegistryResponse | AgentResponse)[]>([]);
  const [decoys, setDecoys] = useState<DecoyResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedDecoysServerId, setExpandedDecoysServerId] = useState<string | null>(null);

  const copyServerId = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(id).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const toggleExpandDecoys = (serverId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedDecoysServerId((prev) => (prev === serverId ? null : serverId));
  };

  const fetchNodes = (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    Promise.all([
      nodeService.getNodes().catch(() => [] as NodeInventory[]),
      serverService.listServers().catch(() => [] as ServerResponse[]),
      agentService.listAgents().catch(() => [] as AgentRegistryResponse[]),
      agentService.getAgents().catch(() => [] as AgentResponse[]),
      decoyService.listDecoys().catch(() => [] as DecoyResponse[]),
    ])
      .then(([nodesData, serversData, regAgents, dashAgents, decoysData]) => {
        setNodes(Array.isArray(nodesData) ? nodesData : []);
        setServers(Array.isArray(serversData) ? serversData : []);
        const combinedAgents = [
          ...(Array.isArray(regAgents) ? regAgents : []),
          ...(Array.isArray(dashAgents) ? dashAgents : []),
        ];
        setAgents(combinedAgents);
        setDecoys(Array.isArray(decoysData) ? decoysData : []);
        if (!silent) setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load infrastructure telemetry:", err);
        if (!silent) {
          setError(err.message);
          setLoading(false);
        }
      });
  };

  useEffect(() => {
    fetchNodes(false);
    const interval = setInterval(() => {
      fetchNodes(true);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Merge nodes, servers & agents to ensure all provisioned & online servers are represented
  const mergedServersList = useMemo(() => {
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
    }> = [];

    // Helper to resolve decoys for a server (no mock fallback)
    const getDecoys = (sid: string, hname?: string) => {
      return decoys.filter(
        (d) =>
          d.server_id === sid ||
          (hname && d.server_id?.toLowerCase() === hname.toLowerCase())
      );
    };

    // 1. Process active nodes with live telemetry
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
        plantedDecoys: getDecoys(serverId, hostname),
      });
    });

    // 2. Process provisioned servers from registry
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
          plantedDecoys: getDecoys(s.id, s.hostname),
        });
      }
    });

    // 3. Process agents that have attached servers
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
          plantedDecoys: getDecoys(serverId, hostname),
        });
      }
    });

    // Prioritize online servers at the top of the list
    return list.sort((a, b) => {
      if (a.isOnline && !b.isOnline) return -1;
      if (!a.isOnline && b.isOnline) return 1;
      return a.hostname.localeCompare(b.hostname);
    });
  }, [nodes, servers, agents, decoys]);

  const onlineServersCount = mergedServersList.filter((s) => s.isOnline).length;
  const totalDecoysPlanted = mergedServersList.reduce((acc, s) => acc + s.plantedDecoys.length, 0);

  return (
    <section className="space-y-3">
      {/* Header with Online Servers Metric & Decoys Summary */}
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-headline font-bold text-primary">
            Managed Infrastructure
          </h2>
          <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            {onlineServersCount} Agent Server{onlineServersCount === 1 ? "" : "s"}
          </span>
        </div>

        <div className="flex gap-1.5 items-center">
          <button
            onClick={() => fetchNodes()}
            className="p-1.5 bg-surface-container-low rounded-lg hover:bg-surface-container-high transition-colors"
            title="Refresh infrastructure and planted decoys"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-primary ${loading ? "animate-spin" : ""}`} />
          </button>
          <button className="p-1.5 bg-surface-container-low rounded-lg hover:bg-surface-container-high transition-colors">
            <Grid className="w-3.5 h-3.5 text-on-surface" />
          </button>
          <button className="p-1.5 bg-primary text-white rounded-lg">
            <List className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {error && (
        <div className="text-xs text-error bg-error-container/15 border border-error/15 rounded-lg px-3 py-2">
          Failed to load infrastructure telemetry: {error}
        </div>
      )}

      {/* Merged Servers List */}
      <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1.5">
        {loading && mergedServersList.length === 0 && (
          <div className="flex items-center justify-center py-8 text-on-surface-variant">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            <span className="text-sm">Querying online servers & planted canary decoys...</span>
          </div>
        )}

        {!loading && mergedServersList.length === 0 && !error && (
          <div className="text-center py-8 text-on-surface-variant text-sm">
            No servers registered yet. Use &quot;Add New Server&quot; to onboard your first server.
          </div>
        )}

        {mergedServersList.map((server, sIdx) => {
          const isExpanded = expandedDecoysServerId === server.serverId;
          const serverId = server.serverId;

          return (
            <div
              key={`${server.id || server.serverId}-${sIdx}`}
              className="bg-surface-container-lowest rounded-xl p-4 shadow-sm border border-outline-variant/10 group hover:shadow-md transition-all space-y-3"
            >
              <div className="flex items-center justify-between gap-4 flex-wrap">
                {/* Server Info & Online Status */}
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="relative shrink-0">
                    <Server className="w-7 h-7 text-primary opacity-25" />
                    <div
                      className={`absolute bottom-0 right-0 w-2.5 h-2.5 ${statusColor(server.status)} rounded-full border-2 border-white ${server.isOnline ? "animate-pulse" : ""}`}
                    />
                  </div>
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="font-headline font-bold text-sm text-on-surface leading-tight truncate">
                        {server.hostname}
                      </h4>
                      {statusBadge(server.status)}
                    </div>
                    <div className="flex items-center gap-1.5 font-mono text-[11px] text-primary flex-wrap">
                      <span className="text-[9px] font-bold uppercase tracking-wider text-on-surface-variant/70 font-sans shrink-0">
                        Server ID:
                      </span>
                      <span className="font-bold bg-primary/10 text-primary px-1.5 py-0.5 rounded select-all break-all">
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
                    <p className="text-[10px] text-on-surface-variant flex items-center gap-1.5">
                      <span>{server.location}</span>
                      <span>•</span>
                      <span className="font-mono">{server.ip}</span>
                    </p>
                  </div>
                </div>

                {/* Telemetry Metrics */}
                <div className="flex items-center gap-6 text-center">
                  <div>
                    <p className="text-[9px] font-bold text-on-surface-variant/50 uppercase tracking-widest mb-0.5">
                      CPU
                    </p>
                    <p className={`text-xs font-bold ${cpuColor(server.cpu)} font-mono`}>
                      {formatCpu(server.cpu)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold text-on-surface-variant/50 uppercase tracking-widest mb-0.5">
                      Memory
                    </p>
                    <p className="text-xs font-bold text-primary font-mono">
                      {server.memoryUsed !== null && server.memoryTotal !== null
                        ? `${server.memoryUsed} / ${server.memoryTotal} GB`
                        : "N/A"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold text-on-surface-variant/50 uppercase tracking-widest mb-0.5">
                      Threats
                    </p>
                    <p
                      className={`text-xs font-bold ${server.threats > 0 ? "text-error" : "text-on-surface"}`}
                    >
                      {server.threats > 0 ? `${server.threats} Pending` : "0 Detected"}
                    </p>
                  </div>
                  {/* Decoys Status Pill */}
                  <div className="text-left">
                    <p className="text-[9px] font-bold text-on-surface-variant/50 uppercase tracking-widest mb-0.5">
                      Decoys
                    </p>
                    <button
                      type="button"
                      onClick={(e) => toggleExpandDecoys(serverId, e)}
                      className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 transition-colors"
                      title="View decoys on this server"
                    >
                      <Shield className="w-3 h-3 text-slate-600" />
                      <span>{server.plantedDecoys.length}</span>
                      {isExpanded ? <ChevronUp className="w-3 h-3 text-slate-500" /> : <ChevronDown className="w-3 h-3 text-slate-500" />}
                    </button>
                  </div>

                  <button className="text-primary opacity-0 group-hover:opacity-100 transition-opacity p-1.5 hover:bg-primary/5 rounded-full">
                    <MoreVertical className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Expandable Decoy Canaries Drawer */}
              {isExpanded && (
                <div className="pt-2 border-t border-outline-variant/10 space-y-1.5 animate-in fade-in duration-150">
                  <div className="flex justify-between items-center text-[10px]">
                    <span className="font-semibold text-slate-700 flex items-center gap-1">
                      <Shield className="w-3.5 h-3.5 text-slate-600" /> Deception Assets ({server.plantedDecoys.length}):
                    </span>
                    <span className="text-[9px] text-slate-500">
                      Exact status breakdown
                    </span>
                  </div>
                  <div className="space-y-1">
                    {server.plantedDecoys.map((decoy, dIdx) => {
                      const badge = getDecoyStatusBadge(decoy.status);
                      const BadgeIcon = badge.icon;
                      return (
                        <div
                          key={decoy.id || dIdx}
                          className="flex items-center justify-between gap-2 bg-slate-50 rounded-md px-2.5 py-1 text-[10px] border border-slate-200/70"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <FileCode className="w-3 h-3 text-slate-500 shrink-0" />
                            <span className="font-mono text-slate-800 truncate select-all" title={decoy.file_path}>
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
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
