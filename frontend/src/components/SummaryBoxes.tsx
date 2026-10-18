"use client";

import { useState, useEffect } from "react";
import { AlertTriangle, ShieldCheck, Users, Activity, RefreshCw } from "lucide-react";
import { dashboardService } from "@/services/dashboardService";
import type { SummaryKPIs } from "@/lib/types";

export function SummaryBoxes() {
  const [metrics, setMetrics] = useState<SummaryKPIs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    dashboardService
      .getSummary()
      .then((data) => {
        setMetrics(data);
        if (!silent) setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load summary:", err);
        if (!silent) {
          setError(err.message);
          setLoading(false);
        }
      });
  };

  useEffect(() => {
    fetchSummary(false);
    const interval = setInterval(() => {
      fetchSummary(true);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Display values from API or show dashes while loading
  const criticalAlerts = metrics ? metrics.criticalAlerts : "—";
  const mitigatedIncidents = metrics
    ? typeof metrics.mitigatedIncidents === "number"
      ? metrics.mitigatedIncidents.toLocaleString()
      : metrics.mitigatedIncidents
    : "—";
  const activeAnalysts = metrics ? metrics.activeAnalysts : "—";
  const networkUptime = metrics ? String(metrics.networkUptime) : "—";

  return (
    <div className="space-y-2 mb-6">
      {error && (
        <div className="flex items-center gap-2 text-xs text-error bg-error-container/15 border border-error/15 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">Failed to load KPI data: {error}</span>
          <button
            onClick={() => fetchSummary()}
            className="flex items-center gap-1 text-primary hover:underline font-semibold"
          >
            <RefreshCw className="w-3 h-3" /> Retry
          </button>
        </div>
      )}
      <div className="flex gap-6">
        {/* Card 1 - Critical Alerts */}
        <div className="stat-card flex-1">
          <div className="stat-card-inner rounded-2xl bg-white p-4 flex flex-col gap-1.5 border border-outline-variant/10">
            <div className="flex justify-between items-center mb-1">
              <AlertTriangle className="text-error bg-error-container/20 p-1.5 rounded-xl w-8 h-8" />
              <span className="text-[9px] font-bold text-error uppercase tracking-widest bg-error-container px-2 py-0.5 rounded-full">
                High Alert
              </span>
            </div>
            <p
              className={`text-3xl font-headline font-bold text-on-surface transition-all ${loading ? "animate-pulse opacity-40" : ""}`}
            >
              {criticalAlerts}
            </p>
            <p className="text-xs text-on-surface-variant font-medium">
              Critical Alerts
            </p>
          </div>
        </div>

        {/* Card 2 - Mitigated Incidents */}
        <div className="stat-card flex-1">
          <div className="stat-card-inner rounded-2xl bg-white p-4 flex flex-col gap-1.5 border border-outline-variant/10">
            <div className="flex justify-between items-center mb-1">
              <ShieldCheck className="text-primary bg-primary/5 p-1.5 rounded-xl w-8 h-8" />
              <span className="text-[9px] font-bold text-primary uppercase tracking-widest bg-primary/5 px-2 py-0.5 rounded-full">
                Stable
              </span>
            </div>
            <p
              className={`text-3xl font-headline font-bold text-on-surface transition-all ${loading ? "animate-pulse opacity-40" : ""}`}
            >
              {mitigatedIncidents}
            </p>
            <p className="text-xs text-on-surface-variant font-medium">
              Mitigated Incidents
            </p>
          </div>
        </div>

        {/* Card 3 - Active Analysts */}
        <div className="stat-card flex-1">
          <div className="stat-card-inner rounded-2xl bg-white p-4 flex flex-col gap-1.5 border border-outline-variant/10">
            <div className="flex justify-between items-center mb-1">
              <Users className="text-primary bg-primary/5 p-1.5 rounded-xl w-8 h-8" />
            </div>
            <p
              className={`text-3xl font-headline font-bold text-on-surface transition-all ${loading ? "animate-pulse opacity-40" : ""}`}
            >
              {activeAnalysts}
            </p>
            <p className="text-xs text-on-surface-variant font-medium">
              Active Analysts
            </p>
          </div>
        </div>

        {/* Card 4 - Network Uptime */}
        <div className="stat-card flex-1">
          <div className="stat-card-inner rounded-2xl bg-primary p-4 flex flex-col gap-1.5 text-on-primary">
            <div className="flex justify-between items-center mb-1">
              <Activity className="text-on-primary-container bg-white/10 p-1.5 rounded-xl w-8 h-8" />
            </div>
            <p
              className={`text-3xl font-headline font-bold transition-all ${loading ? "animate-pulse opacity-40" : ""}`}
            >
              {networkUptime}
            </p>
            <p className="text-xs text-on-primary-container font-medium">
              Network Uptime
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
