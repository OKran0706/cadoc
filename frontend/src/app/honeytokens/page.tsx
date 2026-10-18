"use client";

import { useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import {
  Flame, Plus, Copy, Check, Eye, Trash2, AlertTriangle,
  Key, Link2, CreditCard, Terminal, User, X
} from "lucide-react";

type TokenType = "AWS Key" | "GitHub PAT" | "Stripe Key" | "SSH Private Key" | "JWT Token" | "API Key";
type TokenStatus = "Active" | "Triggered" | "Expired";

interface HoneyToken {
  id: string; name: string; type: TokenType;
  masked: string; status: TokenStatus;
  node: string; deployed: string; lastAccess: string | null;
  triggerCount: number;
}

const TOKEN_ICONS: Record<TokenType, React.ElementType> = {
  "AWS Key": Key, "GitHub PAT": Link2, "Stripe Key": CreditCard,
  "SSH Private Key": Terminal, "JWT Token": Key, "API Key": Key,
};

const tokens: HoneyToken[] = [
  { id: "HT-001", name: "prod-aws-access-key", type: "AWS Key", masked: "AKIA••••••••••XQRT", status: "Active", node: "NODE-01", deployed: "3 days ago", lastAccess: null, triggerCount: 0 },
  { id: "HT-002", name: "github-deploy-token", type: "GitHub PAT", masked: "ghp_••••••••••••••7Kz3", status: "Triggered", node: "NODE-02", deployed: "6 days ago", lastAccess: "14:02:31", triggerCount: 3 },
  { id: "HT-003", name: "stripe-live-key", type: "Stripe Key", masked: "sk_live_••••••••••••qP9s", status: "Active", node: "NODE-03", deployed: "1 day ago", lastAccess: null, triggerCount: 0 },
  { id: "HT-004", name: "root-ssh-key", type: "SSH Private Key", masked: "-----BEGIN RSA••••-----", status: "Triggered", node: "NODE-02", deployed: "10 days ago", lastAccess: "13:30:18", triggerCount: 1 },
  { id: "HT-005", name: "internal-api-key", type: "API Key", masked: "sk-int-••••••••••••••Nm7", status: "Expired", node: "NODE-01", deployed: "30 days ago", lastAccess: "2 days ago", triggerCount: 0 },
];

const statusStyle: Record<TokenStatus, string> = {
  Active: "text-emerald-700 bg-emerald-50",
  Triggered: "text-error bg-error-container animate-pulse",
  Expired: "text-on-surface-variant bg-surface-container-high",
};

const TOKEN_TYPES: TokenType[] = ["AWS Key", "GitHub PAT", "Stripe Key", "SSH Private Key", "JWT Token", "API Key"];

export default function HoneytokensPage() {
  const [copied, setCopied] = useState<string | null>(null);
  const [showDeploy, setShowDeploy] = useState(false);
  const [form, setForm] = useState({ name: "", type: "AWS Key" as TokenType, node: "NODE-01" });

  function copy(id: string) {
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }

  const active = tokens.filter(t => t.status === "Active").length;
  const triggered = tokens.filter(t => t.status === "Triggered").length;
  const expired = tokens.filter(t => t.status === "Expired").length;

  return (
    <DashboardLayout>
      <header className="flex justify-between items-end mb-5">
        <div>
          <h1 className="text-2xl font-bold text-primary -tracking-wider flex items-center gap-2">
            <Flame className="w-6 h-6 text-amber-500" /> Honeytokens
          </h1>
          <p className="text-xs text-on-surface-variant mt-0.5">Fake credentials and secrets deployed to detect unauthorized access.</p>
        </div>
        <button
          onClick={() => setShowDeploy(true)}
          className="flex items-center gap-1.5 bg-amber-500 text-white px-5 py-2 rounded-full text-sm font-bold hover:bg-amber-600 transition-colors shadow-lg shadow-amber-500/20"
        >
          <Plus className="w-4 h-4" /> Deploy Token
        </button>
      </header>

      {/* Summary Strip */}
      <div className="flex gap-4 mb-6">
        {[
          { label: "Total Deployed", value: tokens.length, color: "text-primary" },
          { label: "Active", value: active, color: "text-emerald-600" },
          { label: "Triggered", value: triggered, color: "text-error" },
          { label: "Expired", value: expired, color: "text-on-surface-variant" },
        ].map(s => (
          <div key={s.label} className="flex-1 bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-[10px] text-on-surface-variant uppercase tracking-widest font-bold mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Triggered Alert Banner */}
      {triggered > 0 && (
        <div className="flex items-center gap-3 bg-error/5 border border-error/20 rounded-xl px-4 py-3 mb-4">
          <AlertTriangle className="w-4 h-4 text-error shrink-0" />
          <p className="text-xs text-error font-semibold">
            {triggered} honeytoken{triggered > 1 ? "s have" : " has"} been accessed — investigate immediately.
          </p>
        </div>
      )}

      {/* Token Table */}
      <div className="bg-white rounded-2xl border border-outline-variant/10 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-outline-variant/10 flex justify-between items-center">
          <span className="text-xs font-bold text-primary uppercase tracking-widest">Deployed Honeytokens</span>
          <span className="text-[10px] text-on-surface-variant">{tokens.length} total</span>
        </div>
        <div className="divide-y divide-outline-variant/5">
          {tokens.map(token => {
            const Icon = TOKEN_ICONS[token.type];
            return (
              <div
                key={token.id}
                className={`flex items-center gap-4 px-5 py-4 hover:bg-surface-container-low/50 transition-colors group ${token.status === "Triggered" ? "bg-error/[0.02]" : ""}`}
              >
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${token.status === "Triggered" ? "bg-error/10" : "bg-amber-50"}`}>
                  <Icon className={`w-4 h-4 ${token.status === "Triggered" ? "text-error" : "text-amber-600"}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="text-sm font-semibold text-on-surface">{token.name}</p>
                    <span className="text-[9px] font-mono text-on-surface-variant/50">{token.id}</span>
                  </div>
                  <p className="text-[10px] font-mono text-on-surface-variant">{token.masked}</p>
                </div>
                <div className="text-center min-w-[80px]">
                  <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${statusStyle[token.status]}`}>{token.status}</span>
                </div>
                <div className="text-right min-w-[80px]">
                  <p className="text-[10px] text-on-surface-variant">{token.type}</p>
                  <p className="text-[9px] text-on-surface-variant/50">{token.node}</p>
                </div>
                <div className="text-right min-w-[90px]">
                  {token.lastAccess ? (
                    <>
                      <p className="text-[10px] font-mono text-error">{token.lastAccess}</p>
                      <p className="text-[9px] text-on-surface-variant/50">{token.triggerCount}x triggered</p>
                    </>
                  ) : (
                    <p className="text-[10px] text-on-surface-variant/50">Never accessed</p>
                  )}
                </div>
                <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => copy(token.id)} className="p-1.5 hover:bg-surface-container-high rounded-lg transition-colors">
                    {copied === token.id ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 text-on-surface-variant" />}
                  </button>
                  <button className="p-1.5 hover:bg-surface-container-high rounded-lg transition-colors">
                    <Eye className="w-3.5 h-3.5 text-on-surface-variant" />
                  </button>
                  <button className="p-1.5 hover:bg-error-container rounded-lg transition-colors">
                    <Trash2 className="w-3.5 h-3.5 text-error" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Deploy Modal */}
      {showDeploy && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={e => e.target === e.currentTarget && setShowDeploy(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-[fadeUp_0.2s_ease]">
            <div className="flex justify-between items-start mb-5">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 bg-amber-50 rounded-xl flex items-center justify-center">
                  <Flame className="w-4 h-4 text-amber-500" />
                </div>
                <div>
                  <p className="text-sm font-bold text-on-surface">Deploy Honeytoken</p>
                  <p className="text-[10px] text-on-surface-variant">Plant a fake credential as a tripwire</p>
                </div>
              </div>
              <button onClick={() => setShowDeploy(false)} className="p-1.5 hover:bg-surface-container-high rounded-full"><X className="w-4 h-4 text-on-surface-variant" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1.5">Token Name</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. prod-aws-access-key" className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl px-4 py-2.5 text-sm text-on-surface outline-none focus:border-primary/40 transition-colors placeholder:text-on-surface-variant/40" />
              </div>
              <div>
                <label className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1.5">Token Type</label>
                <div className="grid grid-cols-3 gap-2">
                  {TOKEN_TYPES.map(t => (
                    <button key={t} onClick={() => setForm(f => ({ ...f, type: t }))} className={`py-2 px-3 rounded-xl text-xs font-bold border transition-colors ${form.type === t ? "bg-amber-500 text-white border-amber-500" : "border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-high"}`}>{t}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1.5">Deploy To Node</label>
                <select value={form.node} onChange={e => setForm(f => ({ ...f, node: e.target.value }))} className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl px-4 py-2.5 text-sm text-on-surface outline-none focus:border-primary/40 appearance-none">
                  {["NODE-01", "NODE-02", "NODE-03", "NODE-04"].map(n => <option key={n}>{n}</option>)}
                </select>
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setShowDeploy(false)} className="flex-1 py-2.5 rounded-full border border-outline-variant/20 text-sm font-medium text-on-surface-variant hover:bg-surface-container-high transition-colors">Cancel</button>
                <button disabled={!form.name} onClick={() => setShowDeploy(false)} className="flex-1 py-2.5 rounded-full bg-amber-500 text-white text-sm font-bold hover:bg-amber-600 transition-colors disabled:opacity-40">Deploy</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
