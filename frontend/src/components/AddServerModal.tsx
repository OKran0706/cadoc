"use client";

import { useState, useEffect } from "react";
import {
  X,
  Copy,
  Server,
  AlertTriangle,
  AlertCircle,
  Check,
  RefreshCw,
  ChevronRight,
  ChevronLeft,
  Globe,
  Shield,
  Loader2,
  CheckCircle2,
  Building,
  MapPin,
} from "lucide-react";
import { nodeService } from "@/services/nodeService";
import { projectService } from "@/services/projectService";
import { serverService } from "@/services/serverService";
import { adminService } from "@/services/adminService";
import { usePermissions } from "@/lib/rbac";
import type { ProjectResponse } from "@/lib/types";
import { COUNTRIES, getCountryByCode, formatLocation } from "@/lib/countries";
import { SearchableCountrySelect } from "@/components/SearchableCountrySelect";
import {
  validateHostname,
  validateIpAddress,
  validateCountry,
  validateServerForm,
  type ServerFormErrors,
} from "@/lib/serverValidation";

interface AddServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void; // Optional callback to refresh parent node list on completion
  initialTenant?: string;
}

const PROFILES = [
  { id: "honey-web", label: "Honey Web", desc: "HTTP/HTTPS honeypot with deception layer" },
  { id: "honey-ssh", label: "Honey SSH", desc: "SSH canary with credential trapping" },
  // { id: "honey-db", label: "Honey DB", desc: "Database decoy with schema monitoring" },
  { id: "full-sentinel", label: "Full Sentinel", desc: "Complete monitoring + deception suite" },
];

const STEPS = [
  { num: 1, label: "Configure" },
  { num: 2, label: "Deploy" },
  { num: 3, label: "Verify" },
];

export function AddServerModal({ isOpen, onClose, onSuccess, initialTenant }: AddServerModalProps) {
  const [step, setStep] = useState(1);
  const [timeLeft, setTimeLeft] = useState(300);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const [copiedRefresh, setCopiedRefresh] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [token, setToken] = useState("");
  const [installCmd, setInstallCmd] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    country: "",
    cityOrRegion: "",
    location: "",
    ip: "",
    profile: "honey-web",
  });
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const { isPlatformAdmin, user } = usePermissions();
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [newProjectName, setNewProjectName] = useState<string>("");
  const [tenants, setTenants] = useState<string[]>(["mock-acme"]);
  const [selectedTenant, setSelectedTenant] = useState<string>(initialTenant || "mock-acme");

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setTimeLeft(300);
      setGenerating(false);
      setVerifying(false);
      setVerified(false);
      setToken("");
      setInstallCmd("");
      setError(null);
      setTouched({});
      setForm({
        name: "",
        country: "",
        cityOrRegion: "",
        location: "",
        ip: "",
        profile: "honey-web",
      });
      if (initialTenant) {
        setSelectedTenant(initialTenant);
      }

      if (isPlatformAdmin) {
        adminService
          .listClients()
          .then((res) => {
            const slugs = Array.isArray(res)
              ? (res.map((c: any) => c.company_slug || c.slug).filter(Boolean) as string[])
              : [];
            if (!slugs.includes("mock-acme")) slugs.unshift("mock-acme");
            if (initialTenant && !slugs.includes(initialTenant)) slugs.push(initialTenant);
            setTenants(slugs);
          })
          .catch(() => {
            setTenants(["mock-acme"]);
          });
      }

      projectService
        .listProjects()
        .then((res) => {
          const list = Array.isArray(res) ? res : [];
          setProjects(list);
          if (list.length > 0) setSelectedProjectId(list[0].id);
        })
        .catch(() => {
          // Continue gracefully
        });
    }
  }, [isOpen, isPlatformAdmin, initialTenant]);

  // Countdown timer for Step 2
  useEffect(() => {
    if (!isOpen || step !== 2) return;
    const t = setInterval(() => setTimeLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [isOpen, step]);

  if (!isOpen) return null;

  const mins = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const secs = String(timeLeft % 60).padStart(2, "0");
  const isExpiring = timeLeft < 60;

  const refreshCmd = `cadoc-cli refresh --all-nodes --force`;

  // Real-time form validation evaluation
  const validationErrors: ServerFormErrors = validateServerForm(
    {
      name: form.name,
      country: form.country,
      cityOrRegion: form.cityOrRegion,
      ip: form.ip,
      profile: form.profile,
      projectId: selectedProjectId,
      newProjectName: newProjectName,
    },
    projects.length > 0
  );

  const isFormValid = !validationErrors.hasErrors;
  const canAdvanceStep1 = isFormValid && !generating;

  const selectedCountryObj = getCountryByCode(form.country);
  const formattedLocation = form.country
    ? formatLocation(form.country, form.cityOrRegion)
    : form.location;

  const markTouched = (field: string) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
  };

  function copy(text: string, setter: (v: boolean) => void) {
    navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  }

  const handleGenerateToken = async () => {
    // Mark all input fields as touched so validation errors are displayed immediately
    setTouched({
      name: true,
      country: true,
      ip: true,
      project: true,
    });

    if (!isFormValid) {
      setError("Please resolve the highlighted validation errors before generating a token.");
      return;
    }

    setGenerating(true);
    setError(null);
    try {
      let targetProjectId = selectedProjectId;
      if (!targetProjectId && newProjectName.trim()) {
        try {
          const createdProj = await projectService.createProject({
            name: newProjectName.trim(),
            company_slug: isPlatformAdmin ? selectedTenant : (user?.companySlug || undefined),
          });
          targetProjectId = createdProj.id;
        } catch {
          // ignore project creation error
        }
      }

      let createdServerId: string | null = null;
      if (targetProjectId) {
        try {
          const s = await serverService.createServer({
            project_id: targetProjectId,
            hostname: form.name.trim(),
            ip_address: form.ip.trim(),
            status: "online",
            specs: {
              location: formattedLocation,
              country: form.country,
              city: form.cityOrRegion.trim() || undefined,
              profile: form.profile,
            },
            company_slug: isPlatformAdmin ? selectedTenant : (user?.companySlug || undefined),
          });
          if (s?.id) createdServerId = s.id;
        } catch (e: any) {
          console.warn("Server creation notice:", e.message);
        }
      }

      const res = await nodeService.generateToken(createdServerId || form.name);
      setToken(res.token);
      setInstallCmd(res.install_command);

      // Calculate remaining seconds securely
      const expiresMs = res.expires_at > 10000000000 ? res.expires_at : res.expires_at * 1000;
      const secsLeft = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
      setTimeLeft(secsLeft > 0 ? secsLeft : 300);

      setStep(2);
    } catch (err: any) {
      console.error("Token generation failed:", err);
      setError(err.message || "Failed to generate deployment token. Please try again.");
    } finally {
      setGenerating(false);
    }
  };

  const handleVerify = async () => {
    setVerifying(true);
    setError(null);
    try {
      const res = await nodeService.verifyServer(form.name);
      if (res.verified) {
        setVerified(true);
      } else {
        setError(`Agent not reporting yet. Status: ${res.status || "offline"}. Make sure the script was run.`);
      }
    } catch (err: any) {
      console.error("Verification failed:", err);
      setError(err.message || "Connection verification failed.");
    } finally {
      setVerifying(false);
    }
  };

  function handleFinish() {
    if (onSuccess) onSuccess();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden animate-[fadeUp_0.2s_ease] border border-outline-variant/10">
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-6 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center">
              <Server className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-base font-bold text-on-surface">Add New Server</h2>
              <p className="text-xs text-on-surface-variant">
                Step {step}: {step === 1 ? "Configure Server & Placement" : step === 2 ? "Deploy Tactical Sentinel" : "Verify Deployment"}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-surface-container-high rounded-full transition-colors"
          >
            <X className="w-4 h-4 text-on-surface-variant" />
          </button>
        </div>

        {/* Stepper */}
        <div className="px-6 pb-5">
          <div className="flex items-center justify-between">
            {STEPS.map((s, i) => (
              <div key={s.num} className="flex items-center flex-1 last:flex-none">
                {/* Step circle + label */}
                <div className="flex items-center gap-2">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300 ${
                      step > s.num
                        ? "bg-emerald-500 text-white"
                        : step === s.num
                          ? "bg-primary text-white shadow-lg shadow-primary/30"
                          : "bg-surface-container-high text-on-surface-variant"
                    }`}
                  >
                    {step > s.num ? <Check className="w-4 h-4" /> : s.num}
                  </div>
                  <span
                    className={`text-[11px] font-semibold transition-colors ${
                      step >= s.num ? "text-on-surface" : "text-on-surface-variant/50"
                    }`}
                  >
                    {s.label}
                  </span>
                </div>
                {/* Connector line */}
                {i < STEPS.length - 1 && (
                  <div className="flex-1 mx-3 h-[2px] rounded-full overflow-hidden bg-surface-container-high">
                    <div
                      className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                      style={{ width: step > s.num ? "100%" : "0%" }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Dynamic Error Banner */}
        {error && (
          <div className="mx-6 mb-4 flex gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <p className="text-xs text-red-800 font-medium">{error}</p>
          </div>
        )}

        {/* Step Content */}
        <div className="px-6 pb-6 space-y-4 max-h-[72vh] overflow-y-auto">
          {/* STEP 1: Configure */}
          {step === 1 && (
            <>
              {isPlatformAdmin && (
                <div className="bg-primary/5 p-3 rounded-xl border border-primary/20">
                  <label className="text-[10px] font-bold text-primary uppercase tracking-widest block mb-1.5 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Building className="w-3.5 h-3.5 text-primary" />
                      Target Client Tenant (Organization)
                    </span>
                    <span className="text-[9px] text-primary/70 font-mono font-normal">Cross-Tenant Superadmin</span>
                  </label>
                  <select
                    value={selectedTenant}
                    onChange={(e) => setSelectedTenant(e.target.value)}
                    className="w-full bg-white border border-primary/20 rounded-xl px-3.5 py-2 text-sm font-semibold text-on-surface outline-none focus:border-primary transition-colors"
                  >
                    {tenants.map((slug) => (
                      <option key={slug} value={slug}>
                        {slug} (client_{slug})
                      </option>
                    ))}
                  </select>
                  <p className="text-[10px] text-on-surface-variant/70 mt-1.5">
                    Server registration and Brokered Join Token will be provisioned directly into this tenant&apos;s isolated database schema.
                  </p>
                </div>
              )}

              {/* Project Selection with Validation */}
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">
                    Target Project *
                  </label>
                  {touched.project && !validationErrors.project && (
                    <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-1">
                      <Check className="w-3 h-3" /> Valid
                    </span>
                  )}
                </div>
                {projects.length > 0 ? (
                  <select
                    value={selectedProjectId}
                    onChange={(e) => {
                      setSelectedProjectId(e.target.value);
                      markTouched("project");
                    }}
                    onBlur={() => markTouched("project")}
                    className={`w-full bg-surface-container-low border rounded-xl px-4 py-2.5 text-sm text-on-surface outline-none transition-colors ${
                      touched.project && validationErrors.project
                        ? "border-red-400 bg-red-50/20 focus:border-red-500"
                        : "border-outline-variant/20 focus:border-primary/40"
                    }`}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={newProjectName}
                    onChange={(e) => {
                      setNewProjectName(e.target.value);
                      markTouched("project");
                    }}
                    onBlur={() => markTouched("project")}
                    placeholder="e.g. Production Cluster (Project name)"
                    className={`w-full bg-surface-container-low border rounded-xl px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/40 outline-none transition-colors ${
                      touched.project && validationErrors.project
                        ? "border-red-400 bg-red-50/20 focus:border-red-500"
                        : "border-outline-variant/20 focus:border-primary/40"
                    }`}
                  />
                )}
                {touched.project && validationErrors.project && (
                  <p className="flex items-center gap-1 text-[11px] text-red-600 font-medium mt-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {validationErrors.project}
                  </p>
                )}
              </div>

              {/* Hostname with Strict RFC 1123 Validation */}
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">
                    Server ID / Hostname *
                  </label>
                  {touched.name && !validationErrors.name && form.name && (
                    <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-1">
                      <Check className="w-3 h-3" /> Valid Hostname
                    </span>
                  )}
                </div>
                <div className="relative">
                  <input
                    value={form.name}
                    onChange={(e) => {
                      const val = e.target.value;
                      setForm((f) => ({ ...f, name: val }));
                      markTouched("name");
                    }}
                    onBlur={() => markTouched("name")}
                    placeholder="e.g. SENTINEL-NODE-05 or cluster-prod-01"
                    className={`w-full bg-surface-container-low border rounded-xl px-4 py-2.5 text-sm font-mono text-on-surface placeholder:text-on-surface-variant/40 outline-none transition-colors ${
                      touched.name && validationErrors.name
                        ? "border-red-400 bg-red-50/20 focus:border-red-500"
                        : "border-outline-variant/20 focus:border-primary/40"
                    }`}
                  />
                </div>
                {touched.name && validationErrors.name ? (
                  <p className="flex items-center gap-1 text-[11px] text-red-600 font-medium mt-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {validationErrors.name}
                  </p>
                ) : (
                  <p className="text-[10px] text-on-surface-variant/70 mt-1">
                    RFC 1123 format: letters, numbers, hyphens, and dots (2–63 characters).
                  </p>
                )}
              </div>

              {/* Country Selection & Placement */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest flex items-center gap-1">
                    <Globe className="w-3 h-3 text-primary" />
                    Country Placement *
                  </label>
                  {touched.country && !validationErrors.country && form.country && (
                    <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-1">
                      <Check className="w-3 h-3" /> {selectedCountryObj?.name}
                    </span>
                  )}
                </div>

                <SearchableCountrySelect
                  value={form.country}
                  onChange={(code) => {
                    setForm((f) => ({
                      ...f,
                      country: code,
                      location: formatLocation(code, f.cityOrRegion),
                    }));
                    markTouched("country");
                  }}
                  onBlur={() => markTouched("country")}
                  hasError={!!(touched.country && validationErrors.country)}
                  errorMessage={validationErrors.country}
                />

                {touched.country && validationErrors.country && (
                  <p className="flex items-center gap-1 text-[11px] text-red-600 font-medium mt-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {validationErrors.country}
                  </p>
                )}

                {/* Optional City / Datacenter region */}
                <div className="pt-1">
                  <div className="relative">
                    <MapPin className="absolute left-3.5 top-3 w-4 h-4 text-on-surface-variant/40 pointer-events-none" />
                    <input
                      value={form.cityOrRegion}
                      onChange={(e) => {
                        const city = e.target.value;
                        setForm((f) => ({
                          ...f,
                          cityOrRegion: city,
                          location: formatLocation(f.country, city),
                        }));
                      }}
                      placeholder="City or Datacenter zone (e.g. Tokyo, Frankfurt, us-east-1)"
                      className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl pl-10 pr-4 py-2 text-xs text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:border-primary/40 transition-colors"
                    />
                  </div>
                </div>

                {/* Location preview badge */}
                {form.country && (
                  <div className="bg-primary/5 border border-primary/15 rounded-lg px-3 py-1.5 flex items-center justify-between text-xs text-primary">
                    <span className="flex items-center gap-1.5 font-medium">
                      <span className="text-base">{selectedCountryObj?.flag}</span>
                      <span>Cluster Location:</span>
                      <strong className="font-bold text-on-surface">{formattedLocation}</strong>
                    </span>
                    <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-primary/10">
                      {selectedCountryObj?.region}
                    </span>
                  </div>
                )}
              </div>

              {/* IP Address with IPv4/IPv6 Validation */}
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">
                    IP Address *
                  </label>
                  {touched.ip && !validationErrors.ip && form.ip && (
                    <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-1">
                      <Check className="w-3 h-3" /> Valid IP
                    </span>
                  )}
                </div>
                <input
                  value={form.ip}
                  onChange={(e) => {
                    const val = e.target.value;
                    setForm((f) => ({ ...f, ip: val }));
                    markTouched("ip");
                  }}
                  onBlur={() => markTouched("ip")}
                  placeholder="e.g. 10.20.1.45 or 192.168.1.100"
                  className={`w-full bg-surface-container-low border rounded-xl px-4 py-2.5 text-sm font-mono text-on-surface placeholder:text-on-surface-variant/40 outline-none transition-colors ${
                    touched.ip && validationErrors.ip
                      ? "border-red-400 bg-red-50/20 focus:border-red-500"
                      : "border-outline-variant/20 focus:border-primary/40"
                  }`}
                />
                {touched.ip && validationErrors.ip ? (
                  <p className="flex items-center gap-1 text-[11px] text-red-600 font-medium mt-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {validationErrors.ip}
                  </p>
                ) : (
                  <p className="text-[10px] text-on-surface-variant/70 mt-1">
                    Valid IPv4 (0.0.0.0 – 255.255.255.255) or standard IPv6.
                  </p>
                )}
              </div>

              {/* Deployment Profile */}
              <div>
                <label className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1.5">
                  Deployment Profile
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {PROFILES.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, profile: p.id }))}
                      className={`text-left p-3 rounded-xl border transition-all cursor-pointer ${
                        form.profile === p.id
                          ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20"
                          : "border-outline-variant/20 hover:bg-surface-container-low"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <Shield className={`w-3.5 h-3.5 ${form.profile === p.id ? "text-primary" : "text-on-surface-variant"}`} />
                        <span className={`text-xs font-bold ${form.profile === p.id ? "text-primary" : "text-on-surface"}`}>
                          {p.label}
                        </span>
                      </div>
                      <p className="text-[10px] text-on-surface-variant leading-snug">{p.desc}</p>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* STEP 2: Deploy */}
          {step === 2 && (
            <>
              {/* Token Row */}
              <div className="bg-surface-container-low rounded-xl px-4 py-3 flex items-center justify-between border border-outline-variant/10">
                <div className="min-w-0 flex-1">
                  <p className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest mb-1">
                    Temporary Join Token
                  </p>
                  <p className="text-xs font-mono text-primary font-semibold break-all">{token}</p>
                </div>
                <div className="text-right shrink-0 ml-4">
                  <p className="text-[9px] font-bold text-on-surface-variant uppercase tracking-widest mb-1">Expires In</p>
                  <p className={`text-base font-bold font-mono ${isExpiring ? "text-error" : "text-primary"}`}>
                    {mins}:{secs}
                  </p>
                </div>
              </div>

              {/* Server Destination Confirmation */}
              <div className="bg-surface-container-low/60 rounded-xl px-4 py-2.5 border border-outline-variant/10 flex items-center justify-between text-xs">
                <span className="text-on-surface-variant flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5 text-primary" /> Target Node Location:
                </span>
                <span className="font-bold text-on-surface flex items-center gap-1.5">
                  <span>{selectedCountryObj?.flag}</span>
                  <span>{formattedLocation}</span>
                </span>
              </div>

              {/* Warning */}
              <div className="flex gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800">
                  Deployment tokens are single-use. If the installation fails or times out, you must restart and generate a new token.
                </p>
              </div>

              {/* Automated Install */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <p className="text-xs font-semibold text-on-surface">Automated Install (Recommended)</p>
                  <button
                    onClick={() => copy(installCmd, setCopiedInstall)}
                    className="flex items-center gap-1 text-[10px] font-bold text-primary hover:text-primary-container transition-colors"
                  >
                    {copiedInstall ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedInstall ? "Copied!" : "Copy"}
                  </button>
                </div>
                <div className="bg-[#0e1117] rounded-xl px-4 py-3">
                  <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap break-all leading-5 select-all">{installCmd}</pre>
                </div>
              </div>

              {/* Refresh Canary */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <p className="text-xs font-semibold text-on-surface">Refresh Canary Assets</p>
                  <button
                    onClick={() => copy(refreshCmd, setCopiedRefresh)}
                    className="flex items-center gap-1 text-[10px] font-bold text-primary hover:text-primary-container transition-colors"
                  >
                    {copiedRefresh ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedRefresh ? "Copied!" : "Copy"}
                  </button>
                </div>
                <div className="bg-[#0e1117] rounded-xl px-4 py-3">
                  <pre className="text-xs font-mono text-emerald-400 select-all">{refreshCmd}</pre>
                </div>
              </div>
            </>
          )}

          {/* STEP 3: Verify */}
          {step === 3 && (
            <>
              {!verified ? (
                <div className="flex flex-col items-center justify-center py-8 gap-4">
                  {verifying ? (
                    <>
                      <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center">
                        <Loader2 className="w-8 h-8 text-primary animate-spin" />
                      </div>
                      <div className="text-center">
                        <p className="text-sm font-bold text-on-surface mb-1">Verifying Deployment...</p>
                        <p className="text-xs text-on-surface-variant">
                          Checking node connectivity and sentinel agent status
                        </p>
                      </div>
                      <div className="w-48 h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                        <div className="h-full bg-primary rounded-full animate-[progress_2.5s_ease-in-out]" />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center">
                        <RefreshCw className="w-8 h-8 text-primary" />
                      </div>
                      <div className="text-center">
                        <p className="text-sm font-bold text-on-surface mb-1">Ready to Verify</p>
                        <p className="text-xs text-on-surface-variant max-w-xs">
                          Run the install command on your server, then click below to verify the agent connected successfully.
                        </p>
                      </div>

                      {/* Server summary */}
                      <div className="w-full bg-surface-container-low rounded-xl p-4 border border-outline-variant/10 space-y-2">
                        <div className="flex justify-between text-xs">
                          <span className="text-on-surface-variant">Server Hostname</span>
                          <span className="font-bold text-on-surface font-mono">{form.name || "—"}</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-on-surface-variant">Country & Location</span>
                          <span className="font-medium text-on-surface flex items-center gap-1.5">
                            {selectedCountryObj?.flag && <span>{selectedCountryObj.flag}</span>}
                            <span>{formattedLocation || "—"}</span>
                          </span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-on-surface-variant">IP Address</span>
                          <span className="font-mono text-on-surface">{form.ip || "—"}</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-on-surface-variant">Profile</span>
                          <span className="font-medium text-on-surface">
                            {PROFILES.find((p) => p.id === form.profile)?.label}
                          </span>
                        </div>
                      </div>

                      <button
                        onClick={handleVerify}
                        className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold bg-primary text-white hover:bg-primary-container transition-colors shadow-lg shadow-primary/20 cursor-pointer"
                      >
                        <RefreshCw className="w-4 h-4" />
                        Verify Deployment
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 gap-4">
                  <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center">
                    <CheckCircle2 className="w-8 h-8 text-emerald-600" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-bold text-on-surface mb-1">Deployment Verified!</p>
                    <p className="text-xs text-on-surface-variant">
                      Sentinel agent is running and reporting to the cluster.
                    </p>
                  </div>

                  {/* Verified info card */}
                  <div className="w-full bg-emerald-50 rounded-xl p-4 border border-emerald-200 space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-emerald-700">Node ID</span>
                      <span className="font-bold text-emerald-800 font-mono">{form.name}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-emerald-700">Country & Location</span>
                      <span className="font-medium text-emerald-800 flex items-center gap-1.5">
                        {selectedCountryObj?.flag && <span>{selectedCountryObj.flag}</span>}
                        <span>{formattedLocation}</span>
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-emerald-700">Status</span>
                      <span className="font-bold text-emerald-600 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        Online
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-emerald-700">Agent Version</span>
                      <span className="font-mono text-emerald-800">v4.2.1</span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Footer Actions */}
          <div className="flex justify-between items-center pt-2">
            <div>
              {step > 1 && !verified && (
                <button
                  onClick={() => setStep((s) => s - 1)}
                  className="flex items-center gap-1 px-4 py-2 rounded-full text-sm font-medium text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back
                </button>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="px-5 py-2.5 rounded-full text-sm font-medium text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer"
              >
                Cancel
              </button>
              {step === 1 && (
                <button
                  onClick={handleGenerateToken}
                  disabled={!canAdvanceStep1}
                  className="flex items-center gap-1.5 px-6 py-2.5 rounded-full text-sm font-bold bg-primary text-white hover:bg-primary-container transition-colors shadow-lg shadow-primary/20 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {generating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      Generate Token
                      <ChevronRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              )}
              {step === 2 && (
                <button
                  onClick={() => setStep(3)}
                  className="flex items-center gap-1.5 px-6 py-2.5 rounded-full text-sm font-bold bg-primary text-white hover:bg-primary-container transition-colors shadow-lg shadow-primary/20 cursor-pointer"
                >
                  Continue
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
              {step === 3 && verified && (
                <button
                  onClick={handleFinish}
                  className="flex items-center gap-1.5 px-6 py-2.5 rounded-full text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 transition-colors shadow-lg shadow-emerald-600/20 cursor-pointer"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  Done
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
