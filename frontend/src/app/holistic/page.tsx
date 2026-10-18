"use client";

import { useState, useRef, useCallback, useMemo, useEffect, Suspense } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Holistic3DView } from "@/components/Holistic3DView";
import { CountryFlag } from "@/components/CountryFlag";
import { IncidentBriefPanel } from "@/components/IncidentBriefPanel";
import { explainIncident, hasActiveIncident } from "@/lib/incidentExplainer";
import { isolateIncidentNode, isResponseSessionCurrent } from "@/lib/incidentContainment";
import { getSessionUser, isAuthenticated, getToken } from "@/services/authService";
import { serverService } from "@/services/serverService";
import { nodeService } from "@/services/nodeService";
import { dashboardService } from "@/services/dashboardService";
import type { ServerResponse, NodeInventory, AlertPayload } from "@/lib/types";
import { hasPermission } from "@/lib/rbac";
import { usePermissions } from "@/lib/rbac";
import {
  TopologyNode,
  buildHolisticNodes,
  INITIAL_TOPOLOGY_NODES,
} from "@/lib/holisticData";
import { formatLocalTime } from "@/lib/geoUtils";
import {
  ShieldAlert, ShieldCheck, Zap, RefreshCw,
  Server, ShieldOff,
  Flame, Radio, X,
  Globe, Orbit, Clock, MapPin,
  RotateCcw, FileText
} from "lucide-react";

// Client-only dynamic import of WorldMapView for optimal bundling & WebGL isolation
const WorldMapView = dynamic(
  () => import("@/components/WorldMapView").then((mod) => mod.WorldMapView),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-[660px] bg-[#060b13] rounded-2xl flex flex-col items-center justify-center border border-outline-variant/20 shadow-2xl">
        <span className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-xs text-on-surface-variant font-mono">Initializing World Map & Vector Telemetry...</p>
      </div>
    ),
  }
);

function HolisticDashboardContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentView = searchParams.get("view") === "world" ? "world" : "topology";

  const { can } = usePermissions();
  const canRespond = can("security.respond") || can("server.manage");

  // Shared state across both views
  const [nodes, setNodes] = useState<TopologyNode[]>(INITIAL_TOPOLOGY_NODES);
  const nodesRef = useRef(nodes);
  const rawServersRef = useRef<ServerResponse[]>([]);
  const rawNodesRef = useRef<NodeInventory[]>([]);
  const rawAlertsRef = useRef<AlertPayload[]>([]);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selectedNode = nodes.find(n => n.id === selectedNodeId) ?? null;
  const selectNode = useCallback((node: TopologyNode | null) => setSelectedNodeId(node?.id ?? null), []);
  const [simulatedTamperNodeId, setSimulatedTamperNodeId] = useState<string | null>(null);
  const [lastSimulatedCountry, setLastSimulatedCountry] = useState<string>("US");
  const autoFollowIncidents = false;
  const [actionMessage, setActionMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [simulatedBanner, setSimulatedBanner] = useState<string | null>(null);

  // Real-time status state
  const [isLiveConnected, setIsLiveConnected] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<string>("Initializing...");
  const [isLiveFleet, setIsLiveFleet] = useState<boolean>(false);

  // AI Incident Brief slide-over state
  const [isBriefOpen, setIsBriefOpen] = useState(false);

  // Fetch real-time data from backend servers, nodes, and alerts
  const fetchRealtimeData = useCallback(async (isManual = false) => {
    if (isManual) setIsLoading(true);
    try {
      const [serversRes, nodesRes, alertsRes] = await Promise.allSettled([
        serverService.listServers(),
        nodeService.getNodes(),
        dashboardService.getAlerts(undefined, 50),
      ]);

      const liveServers = serversRes.status === "fulfilled" ? serversRes.value : [];
      const liveNodes = nodesRes.status === "fulfilled" ? nodesRes.value : [];
      const liveAlerts = alertsRes.status === "fulfilled" && alertsRes.value?.data ? alertsRes.value.data : [];

      rawServersRef.current = liveServers;
      rawNodesRef.current = liveNodes;
      rawAlertsRef.current = liveAlerts;

      const hasLiveItems = liveServers.length > 0 || liveNodes.length > 0;
      setIsLiveFleet(hasLiveItems);

      const builtNodes = buildHolisticNodes(liveNodes, liveServers, liveAlerts);
      nodesRef.current = builtNodes;
      setNodes(builtNodes);
      setLastUpdated(new Date().toLocaleTimeString());

      if (isManual) {
        setActionMessage({
          text: hasLiveItems
            ? `Real-time telemetry synchronized (${liveServers.length} servers, ${liveAlerts.length} alerts).`
            : "Live backend connected. Baseline digital twin mesh synchronized.",
          type: "success",
        });
      }
    } catch (err) {
      console.error("Failed to fetch real-time holistic data:", err);
      if (isManual) {
        setActionMessage({
          text: "Failed to refresh real-time telemetry from backend.",
          type: "error",
        });
      }
    } finally {
      if (isManual) setIsLoading(false);
    }
  }, []);

  // Real-time SSE alert streaming and interval synchronization
  useEffect(() => {
    fetchRealtimeData(false);

    let es: EventSource | null = null;
    try {
      es = dashboardService.getAlertStream();
      if (es) {
        es.onopen = () => setIsLiveConnected(true);
        es.onmessage = (event) => {
          try {
            const incomingAlert: AlertPayload = JSON.parse(event.data);
            if (!incomingAlert?.id) return;

            if (!rawAlertsRef.current.some((a) => a.id === incomingAlert.id)) {
              rawAlertsRef.current = [incomingAlert, ...rawAlertsRef.current].slice(0, 50);
              const updated = buildHolisticNodes(
                rawNodesRef.current,
                rawServersRef.current,
                rawAlertsRef.current
              );
              nodesRef.current = updated;
              setNodes(updated);
              setLastUpdated(new Date().toLocaleTimeString());

              if (/crit|high|tamper|inject|breach/i.test(`${incomingAlert.severity || ""} ${incomingAlert.event_type || ""}`)) {
                setActionMessage({
                  text: `REAL-TIME ALERT: ${incomingAlert.event_type} on ${incomingAlert.hostname || incomingAlert.server_id}`,
                  type: "error",
                });
              }
            }
          } catch {
            // Keep-alive or non-JSON message
          }
        };
        es.onerror = () => {
          setIsLiveConnected(false);
          es?.close();
        };
      }
    } catch (streamErr) {
      console.warn("SSE stream unavailable:", streamErr);
    }

    // 15s polling interval to keep live nodes & metrics fresh
    const interval = setInterval(() => {
      fetchRealtimeData(false);
    }, 15000);

    return () => {
      clearInterval(interval);
      if (es) es.close();
    };
  }, [fetchRealtimeData]);

  const loadData = () => {
    fetchRealtimeData(true);
  };

  // Switch View between Topology 3D and World Map (persisted in URL ?view=...)
  const handleSwitchView = (view: "topology" | "world") => {
    const params = new URLSearchParams(searchParams.toString());
    if (view === "world") {
      params.set("view", "world");
    } else {
      params.delete("view");
    }
    router.replace(`${pathname}?${params.toString()}`);
  };

  // KPI Metrics computed dynamically from live shared state
  const totalMonitored = useMemo(() => {
    return nodes.filter((n) => n.status !== "offline").length;
  }, [nodes]);

  const activeIncidentsCount = useMemo(() => {
    return nodes.filter(hasActiveIncident).length;
  }, [nodes]);

  const canariesCount = useMemo(() => {
    return nodes.filter((n) => n.type === "canary").length;
  }, [nodes]);

  // Generate Incident Brief for currently selected node
  const activeIncidentBrief = useMemo(() => {
    if (!selectedNode || !isBriefOpen) return null;
    return explainIncident(selectedNode, selectedNode.incident, {
      allNodes: nodes,
      engine: "rules",
    });
  }, [selectedNode, nodes, isBriefOpen]);

  // Node has active alert/incident
  const hasActiveAlert = Boolean(selectedNode && hasActiveIncident(selectedNode));

  // Updated Simulate Tamper Attack: picks next non-tampered node in a different country
  const handleSimulateTamperAttack = () => {
    const candidates = nodes.filter(
      (n) => !n.tampered && n.status !== "offline" && n.geo.countryCode !== lastSimulatedCountry
    );
    const pool = candidates.length > 0 ? candidates : nodes.filter((n) => !n.tampered && n.status !== "offline");

    if (pool.length === 0) {
      setActionMessage({
        text: "All available nodes have already been breached or quarantined. Reset simulation to start again.",
        type: "error",
      });
      return;
    }

    const target = pool[Math.floor(Math.random() * pool.length)];

    setNodes((prev) =>
      prev.map((n) =>
        n.id === target.id
          ? {
              ...n,
              tampered: true,
              status: "tampered",
              threats: (n.threats || 0) + 1,
              tamperReason: "Simulated zero-day kernel intrusion & tripwire Canary breach",
              tamperVector: "Remote Code Execution via Shadow Ingress Vector",
              tamperTime: "Just now",
              incident: {
                vector: "Zero-Day Kernel Exploit & Unauthorized Canary Tripwire Probe",
                id: "simulated-" + target.id + "-" + Date.now(),
                nodeId: target.id,
                alertType: "unmapped", state: "active", signals: [], events: [],
                detectedAt: new Date().toISOString(),
                attackOrigin: {
                  lat: target.geo.lat > 0 ? -22.9068 : 52.5200,
                  lng: target.geo.lng > 0 ? -43.1729 : 13.4050,
                  country: target.geo.countryCode === "DE" ? "Brazil" : "Germany",
                  countryCode: target.geo.countryCode === "DE" ? "BR" : "DE",
                  city: target.geo.countryCode === "DE" ? "Rio de Janeiro" : "Berlin",
                  ip: "198.51.100.84",
                },
              },
            }
          : n
      )
    );

    setSimulatedTamperNodeId(target.id);
    setLastSimulatedCountry(target.geo.countryCode);
    selectNode(target);

    const bannerText = `SIMULATED TAMPERING in ${target.geo.city}, ${target.geo.country} - ${target.name} - ${target.facility.name}/${target.placement.floorName}/${target.placement.rack}`;
    setSimulatedBanner(bannerText);
    setActionMessage({ text: bannerText, type: "error" });
  };

  // Reset simulation back to real-time baseline
  const handleResetSimulation = () => {
    const restored = buildHolisticNodes(
      rawNodesRef.current,
      rawServersRef.current,
      rawAlertsRef.current
    );
    nodesRef.current = restored;
    setNodes(restored);
    setSimulatedTamperNodeId(null);
    setSimulatedBanner(null);
    selectNode(null);
    setIsBriefOpen(false);
    setActionMessage({ text: "Simulation reset to baseline. Telemetry synchronized.", type: "success" });
  };

  // Both entry points use this one confirmation and guarded, idempotent mock transition.
  const handleIsolateNode = (node: TopologyNode) => {
    const session = getSessionUser();
    const authorized = hasPermission("security.respond", session) || hasPermission("server.manage", session);
    const authenticated = isResponseSessionCurrent(isAuthenticated(), getToken(), Date.now());
    if (!authorized || !authenticated) {
      setActionMessage({text: "A current session with response permission is required.", type: "error"});
      return;
    }
    const current = nodesRef.current.find(n => n.id === node.id);
    if (!current || current.isolatedAt) return;
    if (!window.confirm("Confirm immediate quarantine of node " + node.name + " (" + node.ip + ")? This isolates the node.")) return;
    const freshSession = getSessionUser();
    const result = isolateIncidentNode(nodesRef.current, {nodeId: node.id, incidentId: node.incident?.id}, {
      canRespond: hasPermission("security.respond", freshSession) || hasPermission("server.manage", freshSession),
      authenticated: isResponseSessionCurrent(isAuthenticated(), getToken(), Date.now()),
      confirmed: true, tenantId: "sentinel-lab", at: new Date().toISOString(),
    });
    nodesRef.current = result.nodes;
    setNodes(result.nodes);
    setActionMessage({text: result.outcome === "isolated" ? "Node " + node.name + " isolated and quarantined from cluster." : "Containment was not applied: " + result.outcome, type: result.outcome === "isolated" ? "success" : "error"});
  };

  return (
    <DashboardLayout>
      {/* Page Header with View Switcher */}
      <header className="flex flex-col md:flex-row md:items-end justify-between mb-5 gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${isLiveConnected ? "bg-emerald-500 animate-pulse" : "bg-emerald-400"}`} />
            <span className="text-[10px] font-bold tracking-widest uppercase text-primary">
              Global Cyber Digital Twin
            </span>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
              isLiveConnected
                ? "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20"
                : "bg-primary/10 text-primary border border-primary/20"
            }`}>
              {isLiveConnected ? "Real-Time Telemetry Stream" : "Live Mesh Synced"}
            </span>
          </div>
          <h1 className="text-2xl font-bold text-primary -tracking-wider">Holistic Organization View</h1>
          <p className="text-xs text-on-surface-variant mt-0.5">
            Real-time telemetry stream · Updated {lastUpdated} · Interactive topology and geospatial inspection
          </p>
        </div>

        {/* Action Controls & View Switcher */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* [Topology 3D] [World Map] Switcher */}
          <div className="flex bg-surface-container-high p-1 rounded-full border border-outline-variant/15 shadow-sm">
            <button
              onClick={() => handleSwitchView("topology")}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer ${
                currentView === "topology"
                  ? "bg-primary text-white shadow-md shadow-primary/20"
                  : "text-on-surface-variant hover:text-primary"
              }`}
            >
              <Orbit className="w-3.5 h-3.5" />
              <span>Topology 3D</span>
            </button>

            <button
              onClick={() => handleSwitchView("world")}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer ${
                currentView === "world"
                  ? "bg-primary text-white shadow-md shadow-primary/20"
                  : "text-on-surface-variant hover:text-primary"
              }`}
            >
              <Globe className="w-3.5 h-3.5" />
              <span>World Map</span>
            </button>
          </div>

          {/* Simulate Tamper Button */}
          <button
            onClick={handleSimulateTamperAttack}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-bold bg-error text-white hover:bg-error/90 transition-all shadow-md shadow-error/20 cursor-pointer"
          >
            <Flame className="w-4 h-4 animate-bounce" />
            <span>Simulate Tamper Attack</span>
          </button>

          {/* Reset Simulation Button */}
          <button
            onClick={handleResetSimulation}
            className="p-2 bg-surface-container-low hover:bg-surface-container-high rounded-full transition-colors text-on-surface-variant cursor-pointer"
            title="Reset Simulation"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          {/* Refresh Telemetry */}
          <button
            onClick={loadData}
            disabled={isLoading}
            className={`p-2 bg-surface-container-low hover:bg-surface-container-high rounded-full transition-colors cursor-pointer ${
              isLoading ? "opacity-50 cursor-wait" : ""
            }`}
            title="Refresh Telemetry"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-primary ${isLoading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </header>

      {/* Simulated Tamper Banner Notification */}
      {simulatedBanner && (
        <div className="mb-4 p-3 bg-error/15 border border-error/30 rounded-xl flex items-center justify-between text-xs text-error font-mono animate-pulse">
          <div className="flex items-center gap-2">
            <Flame className="w-4 h-4" />
            <span className="font-bold">{simulatedBanner}</span>
          </div>
          <button
            onClick={() => setSimulatedBanner(null)}
            className="text-error/70 hover:text-error transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Action Message Toast */}
      {actionMessage && !simulatedBanner && (
        <div
          className={`mb-4 p-3 rounded-xl flex items-center justify-between text-xs font-mono ${
            actionMessage.type === "success"
              ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-400"
              : "bg-error/15 border border-error/30 text-error"
          }`}
        >
          <span>{actionMessage.text}</span>
          <button
            onClick={() => setActionMessage(null)}
            className="opacity-70 hover:opacity-100 transition-opacity ml-3"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Dynamic Infrastructure KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm">
          <div className="flex justify-between items-start">
            <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Monitored Fleet</p>
            <Server className="w-4 h-4 text-primary" />
          </div>
          <p data-testid="monitored-kpi" className="text-xl font-bold text-on-surface mt-1">{totalMonitored} Nodes</p>
          <span className="text-[10px] text-on-surface-variant">
            {isLiveFleet
              ? `Live in ${new Set(nodes.map((n) => n.geo.countryCode)).size} Sovereign Nations`
              : "Live in 6 Sovereign Nations"}
          </span>
        </div>

        <div className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm">
          <div className="flex justify-between items-start">
            <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Active Incidents</p>
            <ShieldAlert className={`w-4 h-4 ${activeIncidentsCount > 0 ? "text-error" : "text-emerald-500"}`} />
          </div>
          <p data-testid="incidents-kpi" className={`text-xl font-bold mt-1 ${activeIncidentsCount > 0 ? "text-error" : "text-emerald-600"}`}>
            {activeIncidentsCount} {activeIncidentsCount === 1 ? "Incident" : "Incidents"}
          </p>
          <span className="text-[10px] text-on-surface-variant">
            {activeIncidentsCount > 0 ? "Containment Pending" : "Zero active threats"}
          </span>
        </div>

        <div className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm">
          <div className="flex justify-between items-start">
            <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Deception Mesh</p>
            <Radio className="w-4 h-4 text-amber-500" />
          </div>
          <p className="text-xl font-bold text-on-surface mt-1">{canariesCount} Canaries</p>
          <span className="text-[10px] text-amber-600 font-medium">Tripwire Secrets & Honeytokens</span>
        </div>

        <div className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm">
          <div className="flex justify-between items-start">
            <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Ingestion Lag</p>
            <Zap className="w-4 h-4 text-primary" />
          </div>
          <p className="text-xl font-bold text-primary mt-1">{isLiveConnected ? "24ms" : "38ms"}</p>
          <span className="text-[10px] text-emerald-600 font-medium">
            {isLiveConnected ? "SSE Real-Time Stream Active" : "Global Telemetry Mesh Synced"}
          </span>
        </div>
      </div>

      {/* Main Visualizer Stage (Mounts only one WebGL view at a time) */}
      <div className="relative">
        {currentView === "topology" ? (
          <Holistic3DView
            topologyNodes={nodes}
            simulatedTamperNodeId={simulatedTamperNodeId}
            onSelectNode={selectNode}
            selectedNodeId={selectedNode?.id}
          />
        ) : (
          <WorldMapView
            nodes={nodes}
            selectedNodeId={selectedNode?.id || null}
            onSelectNode={selectNode}
                        onOpenBrief={(nodeId) => {
              const target = nodes.find((n) => n.id === nodeId);
              if (target) {
                selectNode(target);
                setIsBriefOpen(true);
              }
            }}
            autoFollowIncidents={autoFollowIncidents}
          />
        )}

        {/* Enhanced Forensics Inspection HUD (Overlay Drawer) */}
        {selectedNode && (
          <div data-testid="forensics-hud" data-node-id={selectedNode.id} className="absolute top-4 right-4 bottom-4 w-96 max-w-[calc(100%-2rem)] bg-[#0a111e]/95 backdrop-blur-xl border border-outline-variant/30 rounded-2xl p-5 text-white shadow-2xl flex flex-col z-30 animate-in slide-in-from-right duration-200 overflow-y-auto">
            {/* Header */}
            <div className="flex justify-between items-start pb-3 border-b border-white/10 mb-4">
              <div className="flex items-center gap-2.5">
                <div
                  className={`p-2 rounded-xl ${
                    selectedNode.status === "offline"
                      ? "bg-gray-500/20 text-gray-400"
                      : selectedNode.tampered
                      ? "bg-error/20 text-error"
                      : "bg-primary/20 text-primary"
                  }`}
                >
                  {selectedNode.status === "offline" ? (
                    <ShieldOff className="w-5 h-5" />
                  ) : selectedNode.tampered ? (
                    <ShieldAlert className="w-5 h-5" />
                  ) : (
                    <ShieldCheck className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-1.5">
                    <CountryFlag code={selectedNode.geo.countryCode} className="w-4 h-3" />
                    <h3 className="font-bold text-sm text-white truncate max-w-[170px]">{selectedNode.name}</h3>
                  </div>
                  <p className="text-[10px] text-on-surface-variant font-mono">{selectedNode.ip}</p>
                </div>
              </div>
              <button
                onClick={() => selectNode(null)}
                className="p-1 rounded-full hover:bg-white/10 text-on-surface-variant hover:text-white transition-colors cursor-pointer"
                aria-label="Close Forensics HUD"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Status Alert Banner */}
            <div
              className={`p-3 rounded-xl mb-3 border ${
                selectedNode.status === "offline"
                  ? "bg-gray-800/40 border-gray-600/40 text-gray-300"
                  : selectedNode.tampered
                  ? "bg-error/15 border-error/30 text-error"
                  : selectedNode.status === "warning"
                  ? "bg-amber-500/15 border-amber-500/30 text-amber-400"
                  : "bg-emerald-500/15 border-emerald-500/30 text-emerald-400"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-bold uppercase tracking-wider">
                  {selectedNode.status === "offline"
                    ? (selectedNode.isolatedAt ? "Quarantined / Isolated" : "Offline / Heartbeat lost")
                    : selectedNode.tampered
                    ? "🚨 Active Tamper Detected"
                    : "Nominal Health"}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed opacity-90">
                {selectedNode.tamperReason ||
                  "Continuous telemetry active. No policy violations or canary triggers recorded."}
              </p>
            </div>

            {/* PRIMARY ACTION: "Explain this incident" (Only shown for nodes with active alerts) */}
            {hasActiveAlert && (
              <button
                onClick={() => setIsBriefOpen(true)}
                className="w-full mb-3 flex items-center justify-center gap-2 py-2.5 px-4 rounded-md text-xs font-semibold bg-[#294958] hover:bg-[#355b6a] text-white border border-[#527381] focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <FileText className="w-4 h-4" />
                <span>Explain this incident</span>
              </button>
            )}

            {/* WHERE: Location, Physical Facility & Rack Placement */}
            <div className="space-y-3 flex-1 text-xs">
              <div>
                <span className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest flex items-center gap-1">
                  <MapPin className="w-3 h-3 text-primary" /> WHERE (Physical & Cloud Location)
                </span>
                <div className="bg-white/5 rounded-xl p-3 mt-1 space-y-1.5 font-mono text-[11px]">
                  <div className="flex justify-between items-center">
                    <span className="text-on-surface-variant">Country:</span>
                    <span className="text-white font-medium flex items-center gap-1">
                      <CountryFlag code={selectedNode.geo.countryCode} className="w-3.5 h-2.5" />
                      {selectedNode.geo.country}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant">City / Coordinates:</span>
                    <span className="text-white font-medium">
                      {selectedNode.geo.city} ({selectedNode.geo.lat.toFixed(2)}, {selectedNode.geo.lng.toFixed(2)})
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant">Cloud Region / AZ:</span>
                    <span className="text-primary-container font-medium">{selectedNode.geo.cloudRegion}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant">Facility:</span>
                    <span className="text-white font-medium">{selectedNode.facility.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant">Floor / Rack / Unit:</span>
                    <span className="text-emerald-400 font-bold">
                      {selectedNode.placement.floorName.split(":")[0]} • {selectedNode.placement.rack} • {selectedNode.placement.unit}
                    </span>
                  </div>
                  <div className="flex justify-between items-center pt-1 border-t border-white/5">
                    <span className="text-on-surface-variant flex items-center gap-1">
                      <Clock className="w-3 h-3 text-on-surface-variant" /> Site Local Time:
                    </span>
                    <span className="text-white font-mono font-bold">
                      {formatLocalTime(selectedNode.geo.timezone)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-on-surface-variant">Compliance Standard:</span>
                    <span className="text-xs font-bold text-amber-300">{selectedNode.geo.compliance}</span>
                  </div>
                </div>
              </div>

              {/* HOW: Attack Vector & Simulated Attack Origin */}
              {selectedNode.incident && (
                <div>
                  <span className="text-[9px] font-bold text-error uppercase tracking-widest flex items-center gap-1">
                    <Flame className="w-3 h-3" /> HOW (Attack Vector & Origin)
                  </span>
                  <div className="bg-error/10 border border-error/20 rounded-xl p-3 mt-1 space-y-1.5 text-[11px]">
                    <p className="text-white font-medium leading-tight">
                      {selectedNode.incident.vector}
                    </p>
                    {selectedNode.incident.attackOrigin && <><div className="flex justify-between items-center pt-1 border-t border-error/20 text-[10px] font-mono">
                      <span className="text-on-surface-variant">Attack Origin:</span>
                      <span className="text-error font-bold flex items-center gap-1">
                        <CountryFlag code={selectedNode.incident.attackOrigin.countryCode} className="w-3.5 h-2.5" />
                        {selectedNode.incident.attackOrigin.city}, {selectedNode.incident.attackOrigin.country}
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-[10px] font-mono">
                      <span className="text-on-surface-variant">Inbound IP:</span>
                      <span className="text-white">{selectedNode.incident.attackOrigin.ip}</span>
                    </div></>}
                    <div className="flex justify-between items-center text-[10px] font-mono">
                      <span className="text-on-surface-variant">Detected At:</span>
                      <span className="text-white">{selectedNode.incident.detectedAt}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Telemetry Load */}
              <div>
                <span className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest">
                  Telemetry Load
                </span>
                <div className="bg-white/5 rounded-xl p-3 mt-1 space-y-2">
                  <div>
                    <div className="flex justify-between text-[10px] text-on-surface-variant mb-1 font-mono">
                      <span>CPU Utilization</span>
                      <span className={selectedNode.cpu > 80 ? "text-error font-bold" : "text-white"}>
                        {selectedNode.cpu}%
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${selectedNode.cpu > 80 ? "bg-error" : "bg-primary"}`}
                        style={{ width: `${selectedNode.cpu}%` }}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-[10px] text-on-surface-variant mb-1 font-mono">
                      <span>Memory Allocation</span>
                      <span className={selectedNode.memory > 80 ? "text-amber-400 font-bold" : "text-white"}>
                        {selectedNode.memory}%
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${selectedNode.memory > 80 ? "bg-amber-400" : "bg-primary-container"}`}
                        style={{ width: `${selectedNode.memory}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Containment Write Actions */}
            <div className="mt-4 pt-3 border-t border-white/10 space-y-2">
              <button
                onClick={() => handleIsolateNode(selectedNode)}
                disabled={Boolean(selectedNode.isolatedAt) || !canRespond}
                className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-bold transition-colors shadow-lg cursor-pointer ${
                  selectedNode.status === "offline"
                    ? "bg-gray-700 text-gray-400 cursor-not-allowed"
                    : "bg-error hover:bg-error/90 text-white shadow-error/20"
                }`}
              >
                <ShieldOff className="w-4 h-4" />
                <span>
                  {selectedNode.isolatedAt ? "Node Already Quarantined" : "Isolate Node from Cluster"}
                </span>
              </button>

              <button
                onClick={() => selectNode(null)}
                className="w-full py-2 px-4 rounded-xl text-xs font-medium text-on-surface-variant hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
              >
                Dismiss Inspector
              </button>
            </div>
          </div>
        )}
      </div>

      {/* AI Incident Brief Slide-Over Panel */}
      <IncidentBriefPanel
        isOpen={isBriefOpen}
        onClose={() => setIsBriefOpen(false)}
        brief={activeIncidentBrief}
        selectedNode={selectedNode}
        allNodes={nodes}
        onSelectNeighbourNode={(nodeId) => {
          const target = nodes.find((n) => n.id === nodeId);
          if (target) {
            selectNode(target);
          }
        }}
        onIsolateNode={handleIsolateNode}
        canRespond={canRespond}
      />
    </DashboardLayout>
  );
}

export default function HolisticPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-surface flex items-center justify-center">
          <div className="text-center">
            <span className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin inline-block mb-3" />
            <p className="text-xs text-on-surface-variant font-mono">Synchronizing Global Cyber Digital Twin...</p>
          </div>
        </div>
      }
    >
      <HolisticDashboardContent />
    </Suspense>
  );
}
