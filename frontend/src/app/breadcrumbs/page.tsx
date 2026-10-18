"use client";

import { useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Footprints, Plus, Link2, Mail, Globe, Hash, Wifi, X, ChevronRight, Activity } from "lucide-react";

type BreadcrumbType = "DNS Name" | "Email Address" | "URL" | "IP Address" | "Domain";
type BreadcrumbStatus = "Active" | "Triggered" | "Stale";

interface Breadcrumb {
  id: string; value: string; type: BreadcrumbType;
  status: BreadcrumbStatus; planted: string;
  triggeredAt: string | null; triggerCount: number;
  trail: string[];
}

const TYPE_ICON: Record<BreadcrumbType, React.ElementType> = {
  "DNS Name": Globe, "Email Address": Mail, "URL": Link2,
  "IP Address": Wifi, "Domain": Hash,
};
const TYPE_COLOR: Record<BreadcrumbType, string> = {
  "DNS Name": "bg-blue-50 text-blue-600",
  "Email Address": "bg-emerald-50 text-emerald-600",
  "URL": "bg-orange-50 text-orange-600",
  "IP Address": "bg-purple-50 text-purple-600",
  "Domain": "bg-primary/5 text-primary",
};
const STATUS_STYLE: Record<BreadcrumbStatus, string> = {
  Active: "bg-emerald-50 text-emerald-700",
  Triggered: "bg-error-container text-error",
  Stale: "bg-surface-container-high text-on-surface-variant",
};

const breadcrumbs: Breadcrumb[] = [
  {
    id: "BC-001", type: "DNS Name", value: "internal-db.corp.sentinel.svc",
    status: "Active", planted: "5 days ago", triggeredAt: null, triggerCount: 0,
    trail: ["Planted in /etc/hosts", "Resolves to 203.0.113.1 (sink)", "Monitored via DNS intercept"],
  },
  {
    id: "BC-002", type: "Email Address", value: "vault-admin@sentinel.internal",
    status: "Triggered", planted: "8 days ago", triggeredAt: "14:02:31", triggerCount: 2,
    trail: ["Planted in backup_svc env file", "Email lookup from 203.0.113.42", "SMTP handshake logged"],
  },
  {
    id: "BC-003", type: "URL", value: "https://internal.cadoc.io/api/v2/secrets",
    status: "Active", planted: "2 days ago", triggeredAt: null, triggerCount: 0,
    trail: ["Embedded in README.md", "Returns 200 + canary payload", "Access logged via proxy"],
  },
  {
    id: "BC-004", type: "IP Address", value: "10.10.99.254",
    status: "Triggered", planted: "12 days ago", triggeredAt: "13:30:18", triggerCount: 1,
    trail: ["Listed in /etc/network/interfaces", "Ping received from NODE-02", "ARP trace captured"],
  },
  {
    id: "BC-005", type: "Domain", value: "c2-backup.sentinel-infra.net",
    status: "Stale", planted: "30 days ago", triggeredAt: null, triggerCount: 0,
    trail: ["Planted in old env config", "No DNS queries received", "Candidate for rotation"],
  },
];

const TYPES: BreadcrumbType[] = ["DNS Name", "Email Address", "URL", "IP Address", "Domain"];

export default function BreadcrumbsPage() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showPlant, setShowPlant] = useState(false);
  const [form, setForm] = useState({ value: "", type: "DNS Name" as BreadcrumbType });

  const triggered = breadcrumbs.filter(b => b.status === "Triggered");

  return (
    <DashboardLayout>
      <header className="flex justify-between items-end mb-5">
        <div>
          <h1 className="text-2xl font-bold text-primary -tracking-wider flex items-center gap-2">
            <Footprints className="w-6 h-6 text-blue-500" /> Breadcrumbs
          </h1>
          <p className="text-xs text-on-surface-variant mt-0.5">Fake DNS names, emails, URLs and IPs planted to trace attacker reconnaissance paths.</p>
        </div>
        <button onClick={() => setShowPlant(true)} className="flex items-center gap-1.5 bg-blue-600 text-white px-5 py-2 rounded-full text-sm font-bold hover:bg-blue-700 transition-colors shadow-lg shadow-blue-600/20">
          <Plus className="w-4 h-4" /> Plant Breadcrumb
        </button>
      </header>

      {/* Summary */}
      <div className="flex gap-4 mb-6">
        {[
          { label: "Total", value: breadcrumbs.length, color: "text-primary" },
          { label: "Active", value: breadcrumbs.filter(b => b.status === "Active").length, color: "text-emerald-600" },
          { label: "Triggered", value: triggered.length, color: "text-error" },
          { label: "Stale", value: breadcrumbs.filter(b => b.status === "Stale").length, color: "text-on-surface-variant" },
        ].map(s => (
          <div key={s.label} className="flex-1 bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-[10px] text-on-surface-variant uppercase tracking-widest font-bold mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Triggered Alert */}
      {triggered.length > 0 && (
        <div className="flex items-center gap-3 bg-error/5 border border-error/20 rounded-xl px-4 py-3 mb-4">
          <Activity className="w-4 h-4 text-error shrink-0 animate-pulse" />
          <p className="text-xs text-error font-semibold">
            {triggered.length} breadcrumb{triggered.length > 1 ? "s" : ""} accessed — attacker reconnaissance trail detected.
          </p>
        </div>
      )}

      <div className="grid grid-cols-12 gap-6">
        {/* Breadcrumb List */}
        <section className="col-span-8 space-y-3">
          {breadcrumbs.map(b => {
            const Icon = TYPE_ICON[b.type];
            const isOpen = expanded === b.id;
            return (
              <div key={b.id} className={`bg-white rounded-2xl border shadow-sm transition-all ${b.status === "Triggered" ? "border-error/20" : "border-outline-variant/10"}`}>
                <button className="w-full flex items-center gap-4 px-5 py-4 text-left hover:bg-surface-container-low/30 rounded-2xl transition-colors" onClick={() => setExpanded(isOpen ? null : b.id)}>
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${TYPE_COLOR[b.type]}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-sm font-mono font-semibold text-on-surface truncate">{b.value}</p>
                    </div>
                    <p className="text-[10px] text-on-surface-variant">{b.type} · Planted {b.planted}</p>
                  </div>
                  <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full shrink-0 ${STATUS_STYLE[b.status]}`}>{b.status}</span>
                  {b.triggerCount > 0 && (
                    <span className="text-xs font-bold text-error shrink-0">{b.triggerCount}x</span>
                  )}
                  <ChevronRight className={`w-4 h-4 text-on-surface-variant/40 transition-transform shrink-0 ${isOpen ? "rotate-90" : ""}`} />
                </button>

                {/* Trail Details */}
                {isOpen && (
                  <div className="px-5 pb-4 border-t border-outline-variant/5 mt-1 pt-3">
                    <p className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest mb-2">Trail Trace</p>
                    <div className="relative pl-4 space-y-2">
                      <div className="absolute left-1.5 top-1 bottom-1 w-px bg-outline-variant/20" />
                      {b.trail.map((step, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <div className="w-2 h-2 rounded-full bg-primary/30 mt-1 shrink-0 -ml-[1px]" />
                          <p className="text-xs text-on-surface-variant">{step}</p>
                        </div>
                      ))}
                    </div>
                    {b.triggeredAt && (
                      <p className="text-[10px] font-mono text-error mt-3">⚑ Last trigger: {b.triggeredAt}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>

        {/* Info + Tips */}
        <section className="col-span-4 space-y-4">
          <div className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm">
            <p className="text-xs font-bold text-primary uppercase tracking-widest mb-3">How Breadcrumbs Work</p>
            <div className="space-y-3">
              {[
                { step: "Plant", detail: "Embed fake network identifiers in real config files, env vars, or docs." },
                { step: "Monitor", detail: "DNS, SMTP, HTTP, and ARP probes watch for any interaction." },
                { step: "Trigger", detail: "First contact with any breadcrumb fires an immediate high-priority alert." },
                { step: "Trace", detail: "Attacker's source IP, timing and method are captured for forensic analysis." },
              ].map((item, i) => (
                <div key={i} className="flex gap-2.5 items-start">
                  <div className="w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-[9px] font-bold flex items-center justify-center shrink-0">{i + 1}</div>
                  <div>
                    <p className="text-xs font-semibold text-on-surface">{item.step}</p>
                    <p className="text-[10px] text-on-surface-variant leading-4">{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-blue-50 rounded-2xl p-4 border border-blue-100">
            <p className="text-[10px] font-bold text-blue-700 uppercase tracking-widest mb-1">Rotation Policy</p>
            <p className="text-xs text-blue-800">Breadcrumbs older than 21 days with zero triggers are automatically flagged as Stale and should be rotated to maintain believability.</p>
          </div>
        </section>
      </div>

      {/* Plant Modal */}
      {showPlant && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={e => e.target === e.currentTarget && setShowPlant(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-[fadeUp_0.2s_ease]">
            <div className="flex justify-between items-start mb-5">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 bg-blue-50 rounded-xl flex items-center justify-center">
                  <Footprints className="w-4 h-4 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm font-bold text-on-surface">Plant Breadcrumb</p>
                  <p className="text-[10px] text-on-surface-variant">Add a fake network identifier as a tripwire</p>
                </div>
              </div>
              <button onClick={() => setShowPlant(false)} className="p-1.5 hover:bg-surface-container-high rounded-full"><X className="w-4 h-4 text-on-surface-variant" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest block mb-2">Type</label>
                <div className="grid grid-cols-3 gap-2">
                  {TYPES.map(t => (
                    <button key={t} onClick={() => setForm(f => ({ ...f, type: t }))} className={`py-2 px-2 rounded-xl text-[10px] font-bold border transition-colors ${form.type === t ? "bg-blue-600 text-white border-blue-600" : "border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-high"}`}>{t}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1.5">Value</label>
                <input value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} placeholder={form.type === "Email Address" ? "e.g. vault-admin@corp.internal" : form.type === "URL" ? "e.g. https://internal.api/secrets" : "e.g. internal-db.corp.svc"} className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl px-4 py-2.5 text-sm font-mono text-on-surface outline-none focus:border-primary/40 placeholder:text-on-surface-variant/40" />
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setShowPlant(false)} className="flex-1 py-2.5 rounded-full border border-outline-variant/20 text-sm font-medium text-on-surface-variant hover:bg-surface-container-high">Cancel</button>
                <button disabled={!form.value} onClick={() => setShowPlant(false)} className="flex-1 py-2.5 rounded-full bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-40">Plant</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
