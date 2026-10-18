"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { decoyService } from "@/services/decoyService";
import { serverService } from "@/services/serverService";
import { nodeService } from "@/services/nodeService";
import type { DecoyResponse, ServerResponse, NodeInventory } from "@/lib/types";
import {
  Shield, FolderOpen, Eye, ShieldAlert, ShieldCheck,
  RefreshCw, Loader2, AlertTriangle, FileCode, CheckCircle2, Lock, Ghost, Server
} from "lucide-react";

function getBasename(path: string): string {
  if (!path) return "Unnamed Asset";
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function getDecoyTypeIcon(type: string) {
  const t = (type || "").toLowerCase();
  if (t.includes("process")) return Ghost;
  if (t.includes("dir") || t.includes("folder")) return FolderOpen;
  return FileCode;
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
    };
  }
  if (category === "cleaned_up") {
    return {
      category,
      label: raw === "cleaned_up" ? "Cleaned Up" : raw === "removed" ? "Removed" : "Cleaned",
      icon: CheckCircle2,
      pillClass: "text-slate-600 bg-slate-100 border-slate-300",
      dotClass: "bg-slate-400",
    };
  }
  if (category === "pending") {
    return {
      category,
      label: "Pending Verification",
      icon: AlertTriangle,
      pillClass: "text-amber-700 bg-amber-50 border-amber-200",
      dotClass: "bg-amber-500",
    };
  }
  return {
    category,
    label: raw === "active" ? "Active" : "Planted",
    icon: ShieldCheck,
    pillClass: "text-emerald-700 bg-emerald-50 border-emerald-200",
    dotClass: "bg-emerald-500",
  };
}

export default function DecoysPage() {
  const [items, setItems] = useState<DecoyResponse[]>([]);
  const [servers, setServers] = useState<ServerResponse[]>([]);
  const [nodes, setNodes] = useState<NodeInventory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "planted" | "tampered" | "cleaned_up">("all");
  const [hostFilter, setHostFilter] = useState<"all" | "online_tripped" | "online" | "offline">("online_tripped");

  const loadDecoys = useCallback(async (isInitial = false) => {
    if (isInitial) {
      setLoading(true);
      setError(null);
    }
    try {
      const [decoysData, serversData, nodesData] = await Promise.all([
        decoyService.listDecoys().catch(() => [] as DecoyResponse[]),
        serverService.listServers().catch(() => [] as ServerResponse[]),
        nodeService.getNodes().catch(() => [] as NodeInventory[]),
      ]);
      setItems(Array.isArray(decoysData) ? decoysData : []);
      setServers(Array.isArray(serversData) ? serversData : []);
      setNodes(Array.isArray(nodesData) ? nodesData : []);
    } catch (err: any) {
      console.error("Failed to load decoys:", err);
      if (isInitial) {
        setError(err.message || "Failed to load canary decoy inventory.");
      }
    } finally {
      if (isInitial) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadDecoys(true);
    const interval = setInterval(() => {
      loadDecoys(false);
    }, 5000);
    return () => clearInterval(interval);
  }, [loadDecoys]);

  const isServerOnline = useCallback(
    (serverId?: string) => {
      if (!serverId) return false;
      const s = servers.find((srv) => srv.id === serverId);
      const n = nodes.find(
        (node) =>
          node.id === serverId ||
          node.server_id === serverId ||
          node.serverId === serverId ||
          (s?.hostname && node.hostname && node.hostname.toLowerCase() === s.hostname.toLowerCase())
      );
      if (n) {
        return ["online", "active", "healthy"].includes((n.status || "").toLowerCase());
      }
      if (s) {
        return ["online", "active", "healthy"].includes((s.status || "").toLowerCase());
      }
      return false;
    },
    [servers, nodes]
  );

  // Exact lifecycle status metrics
  const stats = {
    total: items.length,
    planted: items.filter((d) => normalizeDecoyStatus(d.status) === "planted").length,
    tampered: items.filter((d) => normalizeDecoyStatus(d.status) === "tampered").length,
    cleanedUp: items.filter((d) => normalizeDecoyStatus(d.status) === "cleaned_up").length,
  };

  const hostStats = useMemo(() => {
    let onlineTripped = 0;
    let online = 0;
    let offline = 0;

    items.forEach((d) => {
      const on = isServerOnline(d.server_id);
      const isTripped = normalizeDecoyStatus(d.status) === "tampered";
      if (on && isTripped) onlineTripped++;
      if (on) online++;
      else offline++;
    });

    return { onlineTripped, online, offline, total: items.length };
  }, [items, isServerOnline]);

  const filteredItems = useMemo(() => {
    return items.filter((d) => {
      const on = isServerOnline(d.server_id);
      const isTripped = normalizeDecoyStatus(d.status) === "tampered";
      if (hostFilter === "online_tripped") {
        if (!on || !isTripped) return false;
      } else if (hostFilter === "online") {
        if (!on) return false;
      } else if (hostFilter === "offline") {
        if (on) return false;
      }

      if (filter === "all") return true;
      return normalizeDecoyStatus(d.status) === filter;
    });
  }, [items, hostFilter, filter, isServerOnline]);

  return (
    <DashboardLayout>
      <header className="flex justify-between items-end mb-5">
        <div>
          <h1 className="text-2xl font-bold text-primary -tracking-wider flex items-center gap-2">
            <Shield className="w-6 h-6 text-slate-700" /> Decoy Vaults
          </h1>
          <p className="text-xs text-on-surface-variant mt-0.5">
            Canary files, honey credentials, and deception sensors planted across cluster nodes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => loadDecoys(true)}
            className="p-2 bg-surface-container-low hover:bg-surface-container-high rounded-full transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-primary ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </header>

      {/* Summary Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Total Decoys", value: stats.total, color: "text-slate-900" },
          { label: "Planted / Armed", value: stats.planted, color: "text-emerald-700" },
          { label: "Tampered / Tripped", value: stats.tampered, color: "text-rose-700" },
          { label: "Cleaned Up / Removed", value: stats.cleanedUp, color: "text-slate-600" },
        ].map((s) => (
          <div
            key={s.label}
            className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm"
          >
            <p className={`text-2xl font-bold font-mono ${s.color}`}>{s.value}</p>
            <p className="text-[10px] text-on-surface-variant uppercase tracking-widest font-bold mt-0.5">
              {s.label}
            </p>
          </div>
        ))}
      </div>

      {/* Tampered / Tripped Alert Banner */}
      {stats.tampered > 0 && (
        <div className="flex items-center gap-3 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 mb-5">
          <ShieldAlert className="w-5 h-5 text-rose-600 shrink-0 animate-pulse" />
          <p className="text-xs text-rose-700 font-semibold flex-1">
            {stats.tampered} canary decoy asset{stats.tampered > 1 ? "s have" : " has"} recorded unauthorized tampering or access — immediate forensic investigation required.
          </p>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-xs text-error bg-error-container/15 border border-error/15 rounded-lg px-3 py-2.5 mb-5">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => loadDecoys(true)} className="font-bold underline hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {/* Host Connectivity Filter */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-xs font-semibold text-on-surface-variant shrink-0">Host State:</span>
        {[
          {
            id: "online_tripped",
            label: `Online Tripped (${hostStats.onlineTripped})`,
            icon: ShieldAlert,
            activeClass: "bg-rose-600 text-white shadow-xs font-bold",
            inactiveClass: "bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100",
          },
          {
            id: "online",
            label: `Online Hosts (${hostStats.online})`,
            icon: CheckCircle2,
            activeClass: "bg-emerald-700 text-white shadow-xs font-bold",
            inactiveClass: "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100",
          },
          {
            id: "offline",
            label: `Offline Hosts (${hostStats.offline})`,
            icon: Shield,
            activeClass: "bg-slate-700 text-white shadow-xs font-bold",
            inactiveClass: "bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200",
          },
          {
            id: "all",
            label: `All Hosts (${hostStats.total})`,
            icon: Server,
            activeClass: "bg-slate-800 text-white shadow-xs font-bold",
            inactiveClass: "bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high",
          },
        ].map((hf) => {
          const Icon = hf.icon;
          const isActive = hostFilter === hf.id;
          return (
            <button
              key={hf.id}
              onClick={() => setHostFilter(hf.id as any)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all uppercase tracking-wider ${
                isActive ? hf.activeClass : hf.inactiveClass
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{hf.label}</span>
            </button>
          );
        })}
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {[
          { id: "all", label: `ALL (${stats.total})` },
          { id: "planted", label: `PLANTED (${stats.planted})` },
          { id: "tampered", label: `TAMPERED (${stats.tampered})` },
          { id: "cleaned_up", label: `CLEANED UP (${stats.cleanedUp})` },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setFilter(tab.id as any)}
            className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all uppercase tracking-wider ${
              filter === tab.id
                ? "bg-slate-800 text-white shadow-sm"
                : "bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-12 gap-6">
        <section className="col-span-8 space-y-3">
          {loading && items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 bg-white rounded-2xl border border-outline-variant/10 shadow-sm">
              <Loader2 className="w-8 h-8 text-primary animate-spin mb-2" />
              <p className="text-xs text-on-surface-variant">Querying decoy inventory across client schema...</p>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="text-center py-12 px-6 bg-white rounded-2xl border border-outline-variant/10 shadow-sm">
              <Shield className="w-10 h-10 text-on-surface-variant/30 mx-auto mb-3" />
              <h3 className="text-sm font-bold text-on-surface mb-1">
                {hostFilter === "online_tripped"
                  ? "No Online Tripped Decoys Found"
                  : hostFilter === "online"
                  ? "No Decoys on Online Hosts Found"
                  : hostFilter === "offline"
                  ? "No Decoys on Offline Hosts Found"
                  : "No Decoy Assets Found"}
              </h3>
              <p className="text-xs text-on-surface-variant max-w-sm mx-auto mb-4">
                {hostFilter === "online_tripped"
                  ? "No active tripwires have recorded unauthorized tampering on online hosts. Your online servers are secure."
                  : "No honeypot files matching this filter. Plant decoy paths on your server to trap malicious actors."}
              </p>
              <div className="flex justify-center items-center gap-2 flex-wrap">
                <button
                  onClick={() => setHostFilter("all")}
                  className="text-xs font-bold px-3 py-1.5 bg-slate-800 text-white rounded-lg hover:bg-slate-700 transition-all"
                >
                  Show All Decoys
                </button>
                <button
                  onClick={() => setHostFilter("online")}
                  className="text-xs font-bold px-3 py-1.5 bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 transition-all"
                >
                  View Online Hosts
                </button>
                <button
                  onClick={() => {
                    setFilter("all");
                    setHostFilter("all");
                  }}
                  className="text-xs font-bold px-3 py-1.5 bg-surface-container-high text-on-surface rounded-lg hover:bg-surface-container-highest transition-all"
                >
                  Reset All Filters
                </button>
              </div>
            </div>
          ) : (
            filteredItems.map((d) => {
              const Icon = getDecoyTypeIcon(d.decoy_type);
              const badge = getDecoyStatusBadge(d.status);
              const BadgeIcon = badge.icon;
              const isTampered = badge.category === "tampered";
              const isOnline = isServerOnline(d.server_id);

              return (
                <div
                  key={d.id}
                  className={`bg-white rounded-2xl px-5 py-4 border shadow-sm flex items-center gap-4 transition-all hover:shadow-md group ${
                    isTampered
                      ? "border-rose-200 bg-rose-50/20"
                      : "border-outline-variant/10"
                  }`}
                >
                  <div
                    className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                      isTampered
                        ? "bg-rose-100 text-rose-700"
                        : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-sm font-mono font-semibold text-on-surface truncate">
                        {d.file_path}
                      </p>
                      <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200 uppercase font-mono">
                        {d.decoy_type || "Canary"}
                      </span>
                    </div>
                    <p className="text-[10px] text-on-surface-variant flex items-center gap-1.5 flex-wrap">
                      <span>Node: <span className="font-mono font-bold text-primary">{d.server_id}</span></span>
                      {isOnline ? (
                        <span className="inline-flex items-center gap-1 text-[8px] font-bold uppercase text-emerald-700 bg-emerald-50 px-1.5 py-0.2 rounded border border-emerald-200">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Online
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[8px] font-bold uppercase text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded border border-slate-200">
                          Offline
                        </span>
                      )}
                      <span>·</span>
                      <span className="font-mono text-[9px]">Hash: {d.original_hash?.slice(0, 10)}...</span>
                    </p>
                  </div>
                  <div className="text-right min-w-[130px]">
                    <span
                      className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border ${badge.pillClass}`}
                    >
                      <BadgeIcon className="w-3.5 h-3.5" />
                      {badge.label}
                    </span>
                    <p className="text-[9px] font-mono text-on-surface-variant/60 mt-1">
                      {d.planted_at ? new Date(d.planted_at).toLocaleDateString() : "Active"}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </section>

        {/* Sidebar Info & Guidance */}
        <section className="col-span-4 space-y-4">
          <div className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm">
            <h3 className="text-xs font-bold text-primary uppercase tracking-widest mb-2 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-primary" /> Deception Policy
            </h3>
            <p className="text-xs text-on-surface-variant leading-relaxed mb-3">
              Canary traps are planted into realistic filesystem paths without legitimate business use. Any read or write access generates instant P1 alerts and initiates host telemetry isolation.
            </p>
            <div className="border-t border-outline-variant/10 pt-3 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Telemetry Ingestion</span>
                <span className="font-bold text-emerald-600">Active</span>
              </div>
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Crypto Hashes</span>
                <span className="font-mono text-[10px] text-on-surface">SHA-256</span>
              </div>
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Tripwire Alerting</span>
                <span className="font-bold text-primary">Zero Tolerance</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </DashboardLayout>
  );
}
