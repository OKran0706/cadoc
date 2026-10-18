"use client";

import { useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import {
  SlidersHorizontal, MessageSquare, Bell, Shield, Key,
  Check, AlertTriangle, RefreshCw, Lock, ChevronDown,
  Zap, Database, Globe, Mail, Server, CheckCircle, XCircle,
} from "lucide-react";

/* ─── TABS ─── */
const TABS = [
  { id: "kafka",  label: "Kafka & Messaging", icon: Zap },
  { id: "alerts", label: "Alert Routing",     icon: Bell },
  { id: "vault",  label: "Vault & Secrets",   icon: Shield },
];

/* ─── HELPERS ─── */
function Field({ label, placeholder, value, mono = false, secret = false }: { label: string; placeholder: string; value: string; mono?: boolean; secret?: boolean }) {
  const [val, setVal] = useState(value);
  const [saved, setSaved] = useState(false);
  function save() { setSaved(true); setTimeout(() => setSaved(false), 2000); }
  return (
    <div>
      <label className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1.5">{label}</label>
      <div className="flex gap-2">
        <input
          type={secret ? "password" : "text"}
          value={val}
          onChange={e => setVal(e.target.value)}
          placeholder={placeholder}
          className={`flex-1 bg-surface-container-low border border-outline-variant/20 rounded-xl px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:border-primary/40 transition-colors ${mono ? "font-mono" : ""}`}
        />
        <button onClick={save} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors shrink-0 ${saved ? "bg-emerald-100 text-emerald-700" : "bg-primary/5 text-primary hover:bg-primary/10"}`}>
          {saved ? <Check className="w-4 h-4" /> : "Save"}
        </button>
      </div>
    </div>
  );
}

function Toggle({ label, desc, defaultOn = true }: { label: string; desc: string; defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-outline-variant/5 last:border-0">
      <div>
        <p className="text-xs font-semibold text-on-surface">{label}</p>
        <p className="text-[10px] text-on-surface-variant mt-0.5">{desc}</p>
      </div>
      <button onClick={() => setOn(!on)} className={`w-10 h-5 rounded-full relative shrink-0 transition-colors mt-0.5 ${on ? "bg-primary" : "bg-outline-variant/30"}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${on ? "left-5" : "left-0.5"}`} />
      </button>
    </div>
  );
}

/* ─── KAFKA TAB ─── */
function KafkaTab() {
  return (
    <div className="grid grid-cols-12 gap-6">
      <div className="col-span-8 space-y-6">
        {/* Cluster Status */}
        <div className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Database className="w-4 h-4 text-primary" />
            <h3 className="text-xs font-bold text-primary uppercase tracking-widest">Kafka Cluster</h3>
            <span className="ml-auto flex items-center gap-1 text-[10px] font-bold text-emerald-600">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block" /> Connected
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-5">
            {[["Brokers", "3 / 3 healthy"],["Partitions","12 active"],["Consumer Lag","0 msgs"]].map(([k,v]) => (
              <div key={k} className="bg-surface-container-low rounded-xl p-3 text-center">
                <p className="text-xs font-bold text-on-surface">{v}</p>
                <p className="text-[9px] text-on-surface-variant uppercase tracking-widest mt-0.5">{k}</p>
              </div>
            ))}
          </div>
          <div className="space-y-3">
            <Field label="Bootstrap Brokers" placeholder="broker1:9092,broker2:9092" value="kafka-01.sentinel.svc:9092,kafka-02.sentinel.svc:9092" mono />
            <Field label="Client ID" placeholder="sentinel-producer" value="cadoc-sentinel-prod" mono />
          </div>
        </div>

        {/* Topic Naming */}
        <div className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <MessageSquare className="w-4 h-4 text-primary" />
            <h3 className="text-xs font-bold text-primary uppercase tracking-widest">Topic Configuration</h3>
          </div>
          <div className="space-y-3">
            {[
              { label: "Critical Alerts Topic",     val: "sentinel.alerts.critical",  ph: "sentinel.alerts.critical" },
              { label: "Warning Events Topic",       val: "sentinel.events.warning",   ph: "sentinel.events.warning" },
              { label: "Telemetry Topic",            val: "sentinel.telemetry.nodes",  ph: "sentinel.telemetry.nodes" },
              { label: "Honeytoken Triggers Topic",  val: "sentinel.deception.tokens", ph: "sentinel.deception.tokens" },
              { label: "Audit Log Topic",            val: "sentinel.audit.immutable",  ph: "sentinel.audit.immutable" },
            ].map(t => <Field key={t.label} label={t.label} placeholder={t.ph} value={t.val} mono />)}
          </div>
        </div>
      </div>

      {/* Right panel */}
      <div className="col-span-4 space-y-4">
        <div className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm">
          <h3 className="text-xs font-bold text-primary uppercase tracking-widest mb-3">Consumer Settings</h3>
          <Toggle label="Auto Offset Reset" desc="Reset to earliest on new consumer group" defaultOn={false} />
          <Toggle label="Enable Compression" desc="gzip compression for all produced messages" />
          <Toggle label="Idempotent Producer" desc="Guarantee exactly-once delivery semantics" />
          <Toggle label="Schema Registry" desc="Avro schema validation on ingestion" defaultOn={false} />
        </div>
        <div className="bg-primary/5 rounded-2xl p-4 border border-primary/10">
          <p className="text-[10px] font-bold text-primary uppercase tracking-widest mb-1">Message Throughput</p>
          <p className="text-2xl font-bold text-primary">4.2M <span className="text-sm font-normal text-on-surface-variant">msg/day</span></p>
          <p className="text-[10px] text-on-surface-variant mt-1">Peak: 12,400 msg/min at 09:30 UTC</p>
        </div>
      </div>
    </div>
  );
}

/* ─── ALERTS TAB ─── */
function AlertsTab() {
  const [testSent, setTestSent] = useState<string | null>(null);
  function sendTest(ch: string) { setTestSent(ch); setTimeout(() => setTestSent(null), 2500); }

  type AlertField = { label: string; ph: string; val: string; secret?: boolean; mono?: boolean };
  type AlertChannel = { id: string; icon: React.ElementType; label: string; color: string; bg: string; fields: AlertField[] };

  const channels: AlertChannel[] = [
    { id: "slack",     icon: MessageSquare, label: "Slack",     color: "text-[#4A154B]", bg: "bg-[#4A154B]/5", fields: [{ label: "Webhook URL", ph: "https://hooks.slack.com/services/...", val: "https://hooks.slack.com/services/T04XYZ/B0••••/••••", secret: true }, { label: "Channel", ph: "#security-alerts", val: "#security-alerts" }] },
    { id: "pagerduty", icon: Bell,          label: "PagerDuty", color: "text-[#25CF3B]", bg: "bg-emerald-50",   fields: [{ label: "Integration Key", ph: "PagerDuty routing key", val: "a1b2c3••••••••••••••••••••••••••", secret: true }, { label: "Service ID", ph: "PXXXXXXX", val: "P8R2QTX" }] },
    { id: "siem",      icon: Shield,        label: "SIEM",      color: "text-primary",   bg: "bg-primary/5",    fields: [{ label: "Syslog Endpoint", ph: "siem.corp.internal:514", val: "siem.corp.internal:514", mono: true }, { label: "Protocol", ph: "TCP / UDP", val: "TCP" }] },
    { id: "email",     icon: Mail,          label: "Email",     color: "text-amber-600", bg: "bg-amber-50",     fields: [{ label: "SMTP Host", ph: "smtp.corp.internal", val: "smtp.corp.internal", mono: true }, { label: "Alert Recipients", ph: "sec@corp.com, oncall@corp.com", val: "sec@corp.com, oncall@corp.com" }] },
  ];

  return (
    <div className="space-y-5">
      {/* Severity routing */}
      <div className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Globe className="w-4 h-4 text-primary" />
          <h3 className="text-xs font-bold text-primary uppercase tracking-widest">Severity Routing Rules</h3>
        </div>
        <div className="space-y-2">
          {[
            { sev: "Critical", badge: "bg-error-container text-error", targets: ["Slack #security-critical", "PagerDuty", "Email"] },
            { sev: "Warning",  badge: "bg-amber-100 text-amber-700",   targets: ["Slack #security-alerts", "Email"] },
            { sev: "Info",     badge: "bg-primary/5 text-primary",     targets: ["Kafka topic only"] },
          ].map(r => (
            <div key={r.sev} className="flex items-center gap-4 py-2.5 border-b border-outline-variant/5 last:border-0">
              <span className={`text-[9px] font-bold px-2.5 py-1 rounded-full w-20 text-center ${r.badge}`}>{r.sev}</span>
              <div className="flex gap-2 flex-wrap">
                {r.targets.map(t => <span key={t} className="text-[10px] bg-surface-container-low px-2 py-0.5 rounded-full text-on-surface-variant font-medium">{t}</span>)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Channel Configs */}
      <div className="grid grid-cols-2 gap-5">
        {channels.map(ch => (
          <div key={ch.id} className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className={`w-8 h-8 rounded-xl ${ch.bg} flex items-center justify-center`}>
                  <ch.icon className={`w-4 h-4 ${ch.color}`} />
                </div>
                <h3 className="text-xs font-bold text-on-surface">{ch.label}</h3>
              </div>
              <button onClick={() => sendTest(ch.id)} className={`text-[10px] font-bold px-3 py-1.5 rounded-full transition-colors ${testSent === ch.id ? "bg-emerald-100 text-emerald-700" : "bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest"}`}>
                {testSent === ch.id ? "✓ Sent!" : "Test"}
              </button>
            </div>
            <div className="space-y-3">
              {ch.fields.map(f => <Field key={f.label} label={f.label} placeholder={f.ph} value={f.val} secret={f.secret} mono={"mono" in f && f.mono} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── VAULT TAB ─── */
function VaultTab() {
  const certs = [
    { name: "mTLS Client Cert — NODE-01", expiry: "2025-08-14", daysLeft: 96,  status: "ok" },
    { name: "mTLS Client Cert — NODE-02", expiry: "2025-06-02", daysLeft: 23,  status: "warn" },
    { name: "mTLS Client Cert — NODE-03", expiry: "2025-05-18", daysLeft: 8,   status: "critical" },
    { name: "Vault CA Root Certificate",  expiry: "2027-01-01", daysLeft: 601, status: "ok" },
    { name: "API Gateway TLS Cert",       expiry: "2025-07-30", daysLeft: 81,  status: "ok" },
  ];

  return (
    <div className="grid grid-cols-12 gap-6">
      <div className="col-span-8 space-y-5">
        {/* Vault Connection */}
        <div className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Lock className="w-4 h-4 text-primary" />
            <h3 className="text-xs font-bold text-primary uppercase tracking-widest">Vault Connection</h3>
            <span className="ml-auto flex items-center gap-1 text-[10px] font-bold text-emerald-600">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block" /> Sealed: No
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            {[["Status","Unsealed"],["Auth Method","AppRole"],["Version","v1.15.4"]].map(([k,v]) => (
              <div key={k} className="bg-surface-container-low rounded-xl p-3 text-center">
                <p className="text-xs font-bold text-on-surface">{v}</p>
                <p className="text-[9px] text-on-surface-variant uppercase tracking-widest mt-0.5">{k}</p>
              </div>
            ))}
          </div>
          <div className="space-y-3">
            <Field label="Vault Address" placeholder="https://vault.corp.internal:8200" value="https://vault.sentinel.internal:8200" mono />
            <Field label="AppRole Role ID" placeholder="role-id" value="sentinel-node-role-v2" mono secret />
            <Field label="Secret Mount Path" placeholder="secret/sentinel" value="secret/sentinel/v1" mono />
          </div>
        </div>

        {/* Certificate Lifecycle */}
        <div className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Key className="w-4 h-4 text-primary" />
              <h3 className="text-xs font-bold text-primary uppercase tracking-widest">Certificate Lifecycle</h3>
            </div>
            <button className="flex items-center gap-1 text-[10px] font-bold text-primary hover:text-primary-container transition-colors">
              <RefreshCw className="w-3.5 h-3.5" /> Rotate All
            </button>
          </div>
          <div className="space-y-2">
            {certs.map((c) => (
              <div key={c.name} className={`flex items-center gap-4 px-4 py-3 rounded-xl border ${c.status === "critical" ? "border-error/20 bg-error/[0.02]" : c.status === "warn" ? "border-amber-200 bg-amber-50/30" : "border-outline-variant/5"}`}>
                {c.status === "ok" && <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />}
                {c.status === "warn" && <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />}
                {c.status === "critical" && <XCircle className="w-4 h-4 text-error shrink-0 animate-pulse" />}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-on-surface">{c.name}</p>
                  <p className="text-[10px] text-on-surface-variant font-mono">Expires: {c.expiry}</p>
                </div>
                <div className="text-right">
                  <p className={`text-xs font-bold ${c.status === "critical" ? "text-error" : c.status === "warn" ? "text-amber-600" : "text-emerald-600"}`}>{c.daysLeft}d</p>
                  <p className="text-[9px] text-on-surface-variant">remaining</p>
                </div>
                <button className="text-[10px] font-bold text-primary px-3 py-1 rounded-lg bg-primary/5 hover:bg-primary/10 transition-colors shrink-0">Rotate</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right Panel */}
      <div className="col-span-4 space-y-4">
        {/* CA Preferences */}
        <div className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm">
          <h3 className="text-xs font-bold text-primary uppercase tracking-widest mb-4">CA Preferences</h3>
          <div className="space-y-2 mb-4">
            {[
              { label: "Use Client CA",     desc: "Use your existing corporate certificate authority" },
              { label: "Self-Signed CA",    desc: "Generate a Sentinel-managed self-signed CA" },
              { label: "Vault PKI Engine",  desc: "Issue certs directly from Vault PKI secrets engine" },
            ].map((opt, i) => (
              <label key={opt.label} className="flex items-start gap-3 p-3 rounded-xl hover:bg-surface-container-low cursor-pointer transition-colors">
                <input type="radio" name="ca" defaultChecked={i === 2} className="mt-0.5 accent-primary" />
                <div>
                  <p className="text-xs font-semibold text-on-surface">{opt.label}</p>
                  <p className="text-[10px] text-on-surface-variant">{opt.desc}</p>
                </div>
              </label>
            ))}
          </div>
          <Field label="PKI Mount Path" placeholder="pki/sentinel" value="pki/sentinel/v1" mono />
        </div>

        {/* mTLS Settings */}
        <div className="bg-white rounded-2xl p-5 border border-outline-variant/10 shadow-sm">
          <h3 className="text-xs font-bold text-primary uppercase tracking-widest mb-3">mTLS Settings</h3>
          <Toggle label="Require mTLS on All Nodes" desc="All inter-node traffic must present valid client cert" />
          <Toggle label="Auto-Rotate Expiring Certs" desc="Auto-rotate certs with < 30 days remaining" />
          <Toggle label="CRL Validation" desc="Check cert revocation list on every handshake" defaultOn={false} />
        </div>

        {/* Critical Cert Warning */}
        {certs.some(c => c.status === "critical") && (
          <div className="bg-error/5 border border-error/20 rounded-2xl p-4 flex gap-3">
            <AlertTriangle className="w-4 h-4 text-error shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-bold text-error">Certificate Expiry Critical</p>
              <p className="text-[10px] text-error/80 mt-0.5">NODE-03 cert expires in 8 days. Rotate immediately to prevent connection failures.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── MAIN PAGE ─── */
export default function SettingsPage() {
  const [tab, setTab] = useState("kafka");

  return (
    <DashboardLayout>
      <header className="flex justify-between items-end mb-5">
        <div>
          <h1 className="text-2xl font-bold text-primary -tracking-wider flex items-center gap-2">
            <SlidersHorizontal className="w-6 h-6" /> Settings
          </h1>
          <p className="text-xs text-on-surface-variant mt-0.5">Platform configuration — Kafka, alert routing, and secrets management.</p>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] font-bold text-on-surface-variant px-3 py-1.5 bg-surface-container-high rounded-full">
          <Server className="w-3.5 h-3.5" /> Admin access required
        </span>
      </header>

      {/* Tab Bar */}
      <div className="flex gap-2 mb-6 bg-surface-container-low p-1 rounded-2xl w-fit">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${tab === t.id ? "bg-white text-primary shadow-sm" : "text-on-surface-variant hover:text-on-surface"}`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "kafka"  && <KafkaTab />}
      {tab === "alerts" && <AlertsTab />}
      {tab === "vault"  && <VaultTab />}
    </DashboardLayout>
  );
}
