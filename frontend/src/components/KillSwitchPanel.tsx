"use client";

import { useState } from "react";
import { ShieldCheck, ShieldAlert, ChevronDown, ChevronUp, Clock, AlertTriangle, Lock, CheckSquare, Square, Zap } from "lucide-react";
import { usePermissions } from "@/lib/rbac";

const CHECKLIST = [
  { id: 1, label: "Verify internal traffic rerouting protocols are synced", tag: "MANDATORY" },
  { id: 2, label: "Notify Tier 3 Response Team via Encrypted Channel", tag: "COMMUNICATIONS" },
  { id: 3, label: "Validate core database backup integrity (Last: 22m ago)", tag: "DATA SAFETY" },
  { id: 4, label: "Confirm physical HSM unlock for crypto-purge keys", tag: "HARDWARE" },
  { id: 5, label: "Final clearance from Chief Security Officer received", tag: "APPROVAL" },
];

const LEVELS = [
  { level: 0, name: "Off",       desc: "Kill switch disabled" },
  { level: 1, name: "Triage",    desc: "Flag & log only" },
  { level: 2, name: "Isolation", desc: "Sever network access" },
  { level: 3, name: "Purge",     desc: "Full deception purge" },
];

const REASONS = [
  "Suspected Lateral Movement",
  "Active Exfiltration Detected",
  "Insider Threat Indicator",
  "Ransomware Deployment",
  "Nation-State Attribution",
  "Manual Override",
];

export function KillSwitchPanel() {
  const { can, role } = usePermissions();
  const canRespond = can("security.respond");

  const [checked, setChecked] = useState<number[]>([]);
  const [selectedLevel, setSelectedLevel] = useState(2);
  const [reason, setReason] = useState(REASONS[0]);
  const [cve, setCve] = useState("");
  const [authorizedBy, setAuthorizedBy] = useState("");
  const [showProtocol, setShowProtocol] = useState(false);
  const [armed, setArmed] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const allChecked = checked.length === CHECKLIST.length;

  function toggle(id: number) {
    setChecked(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  }

  function handleActivate() {
    if (!canRespond) {
      alert(`Access Denied: Role '${role}' lacks 'security.respond' permission.`);
      return;
    }
    if (!allChecked || !authorizedBy) return;
    setConfirming(true);
  }

  function confirmActivate() {
    setArmed(true);
    setConfirming(false);
  }

  if (armed) {
    return (
      <div className="bg-gradient-to-br from-[#1a0000] to-[#3d0000] rounded-2xl p-8 border border-error/30 flex flex-col items-center justify-center gap-4 text-center min-h-[260px]">
        <div className="w-14 h-14 rounded-full bg-error/20 border border-error/40 flex items-center justify-center animate-pulse">
          <ShieldAlert className="w-7 h-7 text-error" />
        </div>
        <h3 className="text-lg font-bold text-white">KILL SWITCH ACTIVE</h3>
        <p className="text-sm text-white/60 max-w-sm">All deception nodes are isolated. Incident report has been filed. Awaiting operator re-authentication to restore services.</p>
        <span className="text-[9px] font-bold text-error uppercase tracking-[0.2em] bg-error/10 px-3 py-1 rounded-full border border-error/20">HARD LOCK — 2FA REQUIRED TO RESTORE</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-xl font-bold text-on-surface">Kill Switch</h2>
          <p className="text-xs text-on-surface-variant mt-0.5">Emergency Network Isolation &amp; Deception Purge Protocol</p>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-on-surface-variant font-medium">
          <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
          Last Test: 14h ago
        </div>
      </div>

      {/* Status Banner */}
      <div className="bg-emerald-50 border border-emerald-200 rounded-2xl px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-emerald-800">KILL SWITCH INACTIVE</p>
            <p className="text-xs text-emerald-700 mt-0.5">All deception assets and network gateways are operating within normal tactical parameters.</p>
          </div>
        </div>
        <div className="text-right shrink-0 ml-6">
          <p className="text-[9px] font-bold text-emerald-600 uppercase tracking-widest mb-0.5">Current State</p>
          <p className="text-xs font-mono font-bold text-emerald-800">NOMINAL_OPERATIONS_01</p>
        </div>
      </div>

      {/* Coverage Level Legend */}
      <div>
        <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest mb-2">Coverage Level Legend</p>
        <div className="flex gap-2">
          {LEVELS.map((l) => (
            <button
              key={l.level}
              onClick={() => setSelectedLevel(l.level)}
              className={`flex-1 rounded-xl px-3 py-2.5 text-center border transition-all ${
                selectedLevel === l.level
                  ? l.level === 0
                    ? "bg-surface-container-highest border-outline-variant text-on-surface"
                    : l.level === 3
                    ? "bg-error border-error text-white"
                    : "bg-primary border-primary text-white"
                  : "border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-high"
              }`}
            >
              <p className="text-[9px] font-bold uppercase tracking-widest opacity-70 mb-0.5">Level {l.level}</p>
              <p className="text-xs font-bold">{l.name}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Main Two-Column */}
      <div className="grid grid-cols-12 gap-5">
        {/* LEFT — Checklist + Protocol */}
        <div className="col-span-7 space-y-4">
          <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">Pre-Activation Checklist</p>
          <div className="space-y-2">
            {CHECKLIST.map((item) => {
              const done = checked.includes(item.id);
              return (
                <button
                  key={item.id}
                  onClick={() => toggle(item.id)}
                  className="w-full flex items-start gap-3 p-3 rounded-xl hover:bg-surface-container-low transition-colors text-left group"
                >
                  {done
                    ? <CheckSquare className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    : <Square className="w-4 h-4 text-on-surface-variant/40 mt-0.5 shrink-0 group-hover:text-on-surface-variant/70 transition-colors" />
                  }
                  <span className="flex-1 text-xs text-on-surface">{item.label}</span>
                  <span className="text-[8px] font-bold tracking-widest text-on-surface-variant/50 uppercase shrink-0 mt-0.5">{item.tag}</span>
                </button>
              );
            })}
          </div>

          {/* Reinstallation Protocol accordion */}
          <div className="bg-surface-container-low rounded-xl overflow-hidden border border-outline-variant/10">
            <button
              onClick={() => setShowProtocol(!showProtocol)}
              className="w-full flex items-center justify-between px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-on-surface-variant" />
                <span className="text-xs font-semibold text-on-surface">Reinstallation Protocol</span>
              </div>
              {showProtocol ? <ChevronUp className="w-4 h-4 text-on-surface-variant" /> : <ChevronDown className="w-4 h-4 text-on-surface-variant" />}
            </button>
            {showProtocol && (
              <div className="px-4 pb-4 space-y-2 border-t border-outline-variant/10">
                <p className="text-xs text-on-surface-variant mt-3 leading-5">
                  Following a Kill Switch activation, the system enters a &quot;Hard Lock&quot; state. Reinstallation requires dual-factor hardware token validation and a minimum of two authorized operators.
                </p>
                <p className="text-xs text-on-surface-variant leading-5">
                  All canary schemas, honeytokens and network routing rules will be purged and must be manually re-provisioned via the secure onboarding flow.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — Activation Details */}
        <div className="col-span-5">
          <div className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm space-y-4 h-full flex flex-col">
            <div>
              <p className="text-xs font-bold text-on-surface mb-0.5">Activation Details</p>
              <p className="text-[10px] text-on-surface-variant leading-4">A detailed log of this activation will be immutably recorded.</p>
            </div>

            {/* Reason */}
            <div>
              <label className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1.5">Activation Reason</label>
              <div className="relative">
                <select
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl px-3 py-2 text-xs text-on-surface outline-none focus:border-primary/40 transition-colors appearance-none"
                >
                  {REASONS.map(r => <option key={r}>{r}</option>)}
                </select>
                <ChevronDown className="absolute right-2.5 top-2.5 w-3.5 h-3.5 text-on-surface-variant pointer-events-none" />
              </div>
            </div>

            {/* CVE */}
            <div>
              <label className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1.5">CVE Reference <span className="font-normal normal-case">(optional)</span></label>
              <input
                value={cve}
                onChange={e => setCve(e.target.value)}
                placeholder="CVE-2024-XXXX"
                className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl px-3 py-2 text-xs font-mono text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:border-primary/40 transition-colors"
              />
            </div>

            {/* Authorized By */}
            <div>
              <label className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1.5">Authorized By</label>
              <div className="relative">
                <input
                  value={authorizedBy}
                  onChange={e => setAuthorizedBy(e.target.value)}
                  placeholder="Operator ID or Email"
                  className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl px-3 py-2 pr-9 text-xs text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:border-primary/40 transition-colors"
                />
                <Lock className="absolute right-2.5 top-2.5 w-3.5 h-3.5 text-on-surface-variant/40" />
              </div>
            </div>

            {/* Warning */}
            <div className="flex gap-2 bg-error/5 border border-error/15 rounded-xl px-3 py-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-error shrink-0 mt-0.5" />
              <p className="text-[10px] text-error leading-4">
                <strong>WARNING:</strong> This action is irreversible via the UI. Network access for all deception nodes and monitored assets will be severed immediately.
              </p>
            </div>

            {/* Activate Button */}
            {!canRespond ? (
              <div
                title={`Role '${role}' cannot trigger emergency network purge (requires security.respond)`}
                className="w-full py-3 rounded-xl bg-surface-container-high text-on-surface-variant/40 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 border border-outline-variant/20 cursor-not-allowed mt-auto"
              >
                <Lock className="w-4 h-4 text-on-surface-variant/40" /> Locked: Requires security.respond
              </div>
            ) : (
              <button
                onClick={handleActivate}
                disabled={!allChecked || !authorizedBy}
                className="w-full py-3 rounded-xl bg-error text-white text-xs font-bold uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-red-700 active:scale-[0.98] transition-all shadow-lg shadow-error/30 disabled:opacity-40 disabled:cursor-not-allowed mt-auto"
              >
                <Zap className="w-4 h-4" /> Activate Kill Switch
              </button>
            )}

            {canRespond && !allChecked && (
              <p className="text-[9px] text-on-surface-variant/50 text-center -mt-2">Complete all checklist items to proceed</p>
            )}
          </div>
        </div>
      </div>

      {/* Activation Latency */}
      <div className="bg-surface-container-low rounded-2xl px-4 py-3 border border-outline-variant/10 flex items-center gap-3">
        <Clock className="w-4 h-4 text-on-surface-variant shrink-0" />
        <div>
          <p className="text-xs font-semibold text-on-surface">Activation Latency</p>
          <p className="text-[10px] text-on-surface-variant">Signal propagation in &lt;180ms across all global regional clusters.</p>
        </div>
      </div>

      {/* Confirmation Dialog */}
      {confirming && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-6 shadow-2xl w-full max-w-sm mx-4 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-error/10 rounded-xl flex items-center justify-center">
                <ShieldAlert className="w-5 h-5 text-error" />
              </div>
              <div>
                <p className="text-sm font-bold text-on-surface">Final Confirmation</p>
                <p className="text-xs text-on-surface-variant">This cannot be undone without 2FA</p>
              </div>
            </div>
            <p className="text-xs text-on-surface-variant bg-error/5 border border-error/15 rounded-xl p-3">
              You are about to activate <strong>Level {selectedLevel} — {LEVELS[selectedLevel].name}</strong> under reason: <strong>{reason}</strong>. All nodes will be immediately isolated.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirming(false)} className="flex-1 py-2.5 rounded-xl border border-outline-variant/20 text-sm font-medium text-on-surface-variant hover:bg-surface-container-high transition-colors">Cancel</button>
              <button onClick={confirmActivate} className="flex-1 py-2.5 rounded-xl bg-error text-white text-sm font-bold hover:bg-red-700 transition-colors">Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
