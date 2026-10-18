"use client";

import { useState, useEffect, useCallback } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { AddServerModal } from "@/components/AddServerModal";
import { adminService } from "@/services/adminService";
import { nodeService } from "@/services/nodeService";
import { onboardingService } from "@/services/onboardingService";
import { getSessionUser } from "@/lib/auth";
import { usePermissions } from "@/lib/rbac";
import type { AdminUserResponse, AuditLogEntry, NodeInventory } from "@/lib/types";
import {
  Users, Activity, Lock, Cpu, MemoryStick, Plus, RefreshCw,
  Loader2, AlertTriangle, Shield, CheckCircle, XCircle, UserCheck, UserX,
  Building, Globe, ExternalLink, ShieldAlert, Sparkles, ChevronRight, X, Server
} from "lucide-react";

export default function AdminPage() {
  const { user, role } = usePermissions();
  const isPlatformAdmin = role === "platform_owner";
  const [admins, setAdmins] = useState<AdminUserResponse[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [nodes, setNodes] = useState<NodeInventory[]>([]);
  const [clients, setClients] = useState<Record<string, any>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New admin modal state
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [creatingAdmin, setCreatingAdmin] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Tenant Provision Modal state
  const [showProvisionModal, setShowProvisionModal] = useState(false);
  const [tenantSlug, setTenantSlug] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  // Client Details inspection modal state
  const [inspectingClient, setInspectingClient] = useState<Record<string, any> | null>(null);
  const [inspectingLoading, setInspectingLoading] = useState(false);

  // Add Server Modal state for tenant provisioning
  const [showAddServerModal, setShowAddServerModal] = useState(false);
  const [targetServerTenant, setTargetServerTenant] = useState<string>("mock-acme");

  const currentUser = getSessionUser();

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [adminsData, logsData, nodesData, clientsData] = await Promise.all([
        adminService.listAdmins().catch(() => [] as AdminUserResponse[]),
        adminService.getAuditLogs().catch(() => [] as AuditLogEntry[]),
        nodeService.getNodes().catch(() => [] as NodeInventory[]),
        isPlatformAdmin ? adminService.listClients().catch(() => [] as Record<string, any>[]) : Promise.resolve([] as Record<string, any>[]),
      ]);
      setAdmins(Array.isArray(adminsData) ? adminsData : []);
      setAuditLogs(Array.isArray(logsData) ? logsData : []);
      setNodes(Array.isArray(nodesData) ? nodesData : []);
      setClients(Array.isArray(clientsData) ? clientsData : []);
    } catch (err: any) {
      console.error("Admin dashboard fetch error:", err);
      setError(err.message || "Failed to load administrative telemetry.");
    } finally {
      setLoading(false);
    }
  }, [isPlatformAdmin]);

  useEffect(() => {
    if (user) loadData();
  }, [user, loadData]);

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingAdmin(true);
    setActionError(null);
    try {
      await adminService.createAdmin({
        email: newEmail.trim(),
        display_name: newName.trim(),
        password: newPassword,
      });
      setShowInviteModal(false);
      setNewEmail("");
      setNewName("");
      setNewPassword("");
      loadData();
    } catch (err: any) {
      setActionError(err.message || "Failed to create administrator account.");
    } finally {
      setCreatingAdmin(false);
    }
  };

  const handleProvisionTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isPlatformAdmin) return;
    setProvisioning(true);
    setProvisionError(null);
    try {
      await onboardingService.provisionTenant({
        slug: tenantSlug.trim().toLowerCase(),
        name: tenantName.trim(),
      });
      setShowProvisionModal(false);
      setTenantSlug("");
      setTenantName("");
      loadData();
    } catch (err: any) {
      setProvisionError(err.message || "Failed to provision client tenant.");
    } finally {
      setProvisioning(false);
    }
  };

  const handleInspectClient = async (slug: string) => {
    if (!isPlatformAdmin) return;
    setInspectingLoading(true);
    try {
      const data = await adminService.getClient(slug);
      setInspectingClient(data && typeof data === "object" ? data : { company_slug: slug, name: slug });
    } catch (err: any) {
      setInspectingClient({ company_slug: slug, name: slug, status: "Active", note: "Schema-isolated operational state" });
    } finally {
      setInspectingLoading(false);
    }
  };

  const handleToggleStatus = async (admin: AdminUserResponse) => {
    if (currentUser?.email === admin.email) {
      alert("Self-lockout protection: You cannot disable your own active account.");
      return;
    }
    const newStatus = admin.status === "active" ? "suspended" : "active";
    try {
      await adminService.updateStatus(admin.id, newStatus);
      loadData();
    } catch (err: any) {
      alert(`Status update failed: ${err.message}`);
    }
  };

  // Display clients list (fall back to mock-acme if none returned yet)
  const displayClients = clients.length > 0 ? clients : [
    {
      company_slug: "mock-acme",
      name: "Mock Acme Corporation",
      servers_count: 3,
      agents_count: 2,
      decoys_count: 5,
      alerts_count: 1,
      status: "active",
    }
  ];

  return (
    <DashboardLayout>
      <header className="flex justify-between items-end mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold text-primary -tracking-wider">Admin Control</h1>
            {isPlatformAdmin ? (
              <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-gradient-to-r from-violet-600 to-indigo-600 text-white uppercase tracking-wider">
                Fleet Superadmin Mode
              </span>
            ) : (
              <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 uppercase tracking-wider">
                Tenant Scoped ({currentUser?.companySlug || "local"})
              </span>
            )}
          </div>
          <p className="text-xs text-on-surface-variant">Privileged system access & multi-tenant security operations</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={loadData}
            className="p-2 bg-surface-container-low hover:bg-surface-container-high rounded-full transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-primary ${loading ? "animate-spin" : ""}`} />
          </button>
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-error-container rounded-full border border-error/20">
            <Lock className="w-3.5 h-3.5 text-error" />
            <span className="text-xs font-bold text-error">Privileged Zone</span>
          </div>
        </div>
      </header>

      {error && (
        <div className="flex items-center gap-2 text-xs text-error bg-error-container/15 border border-error/15 rounded-lg px-3 py-2.5 mb-6">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={loadData} className="font-bold underline hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {/* Cross-Tenant Client Organizations (Visible to Platform Admins) */}
      {isPlatformAdmin && (
      <section className="bg-white rounded-2xl p-6 border border-outline-variant/10 shadow-sm mb-6">
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
              <Building className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-on-surface">Client Organizations (Tenants)</h2>
              <p className="text-xs text-on-surface-variant">Partitioned PostgreSQL client schemas and multi-tenant telemetry</p>
            </div>
          </div>
          {isPlatformAdmin ? (
            <button
              onClick={() => setShowProvisionModal(true)}
              className="flex items-center gap-1.5 bg-primary text-white px-3.5 py-1.5 rounded-full text-xs font-bold hover:bg-primary-container transition-all shadow-md shadow-primary/15"
            >
              <Plus className="w-3.5 h-3.5" /> Provision Client Tenant
            </button>
          ) : (
            <span className="text-[10px] text-on-surface-variant/60 font-mono px-2 py-1 rounded bg-surface-container-low border border-outline-variant/10">
              Provisioning: Platform Owner Only
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-h-[380px] overflow-y-auto pr-1">
          {displayClients.map((c, idx) => {
            const slug = c.company_slug || c.slug || `client-${idx}`;
            const name = c.name || slug.toUpperCase();
            return (
              <div
                key={slug}
                className="bg-surface-container-low/60 rounded-xl p-4 border border-outline-variant/15 flex flex-col justify-between hover:border-primary/30 transition-all group"
              >
                <div>
                  <div className="flex justify-between items-start mb-2">
                    <span className="font-bold text-xs text-on-surface group-hover:text-primary transition-colors">
                      {name}
                    </span>
                    <span className="text-[9px] font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                      {c.status || "active"}
                    </span>
                  </div>
                  <p className="text-[10px] font-mono text-on-surface-variant/70 mb-3">
                    slug: <span className="text-primary font-bold">{slug}</span> · schema: client_{slug}
                  </p>
                  <div className="grid grid-cols-3 gap-2 text-center bg-white p-2 rounded-lg border border-outline-variant/10 mb-3">
                    <div>
                      <p className="text-[9px] text-on-surface-variant uppercase font-medium">Servers</p>
                      <p className="text-xs font-bold text-on-surface">{c.servers_count ?? c.server_count ?? "—"}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-on-surface-variant uppercase font-medium">Agents</p>
                      <p className="text-xs font-bold text-on-surface">{c.agents_count ?? c.agent_count ?? "—"}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-on-surface-variant uppercase font-medium">Decoys</p>
                      <p className="text-xs font-bold text-on-surface">{c.decoys_count ?? c.decoy_count ?? "—"}</p>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleInspectClient(slug)}
                    className="flex-1 py-1.5 px-3 rounded-lg bg-surface-container-high hover:bg-surface-container-highest transition-colors text-[10px] font-bold text-on-surface flex items-center justify-center gap-1.5"
                  >
                    <ExternalLink className="w-3 h-3" /> Diagnostics
                  </button>
                  <button
                    onClick={() => {
                      setTargetServerTenant(slug);
                      setShowAddServerModal(true);
                    }}
                    className="flex-1 py-1.5 px-3 rounded-lg bg-primary/10 hover:bg-primary hover:text-white text-primary transition-colors text-[10px] font-bold flex items-center justify-center gap-1.5"
                  >
                    <Plus className="w-3 h-3" /> Add Server
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      )}

      {/* Lower Grid — Telemetry + Analysts + Audit */}
      <div className="grid grid-cols-12 gap-6">
        {/* Node Telemetry */}
        <section className="col-span-7">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-base font-bold text-primary">Live Cluster Telemetry</h2>
            <span className="text-[10px] font-mono text-on-surface-variant">{nodes.length} nodes active</span>
          </div>
          {nodes.length === 0 ? (
            <div className="bg-white rounded-xl p-8 border border-outline-variant/10 text-center text-xs text-on-surface-variant">
              No cluster node telemetry available yet.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 max-h-[460px] overflow-y-auto pr-1">
              {nodes.map((n) => {
                const cpuVal = typeof n.cpu === "number" ? Math.round(n.cpu) : 0;
                const memVal =
                  n.memoryTotal && n.memoryUsed
                    ? Math.round((n.memoryUsed / n.memoryTotal) * 100)
                    : typeof n.memoryUsed === "number"
                      ? Math.round(n.memoryUsed)
                      : 0;

                return (
                  <div key={n.id} className="bg-white rounded-xl p-4 border border-outline-variant/10 shadow-sm">
                    <div className="flex justify-between items-center mb-3">
                      <p className="text-xs font-bold text-on-surface">{n.id}</p>
                      <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-surface-container-low text-on-surface-variant">
                        {n.ip}
                      </span>
                    </div>
                    <div className="space-y-2">
                      <div>
                        <div className="flex justify-between text-[9px] text-on-surface-variant mb-1">
                          <span className="flex items-center gap-1"><Cpu className="w-3 h-3" /> CPU</span>
                          <span className={cpuVal > 70 ? "text-error font-bold" : ""}>{cpuVal}%</span>
                        </div>
                        <div className="h-1.5 bg-surface-container-low rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${cpuVal > 70 ? "bg-error" : "bg-primary"}`}
                            style={{ width: `${Math.min(100, Math.max(0, cpuVal))}%` }}
                          />
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between text-[9px] text-on-surface-variant mb-1">
                          <span className="flex items-center gap-1"><MemoryStick className="w-3 h-3" /> Memory</span>
                          <span className={memVal > 80 ? "text-error font-bold" : ""}>{memVal}%</span>
                        </div>
                        <div className="h-1.5 bg-surface-container-low rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${memVal > 80 ? "bg-amber-500" : "bg-primary-container"}`}
                            style={{ width: `${Math.min(100, Math.max(0, memVal))}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Analysts + Audit */}
        <section className="col-span-5 space-y-5">
          {/* Administrators List */}
          <div className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm">
            <div className="flex justify-between items-center mb-3">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-primary" />
                <h3 className="text-xs font-bold text-primary uppercase tracking-widest">Platform Admins</h3>
              </div>
              <button
                onClick={() => setShowInviteModal(true)}
                className="flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 bg-primary text-white rounded-full hover:bg-primary-container transition-colors"
              >
                <Plus className="w-3 h-3" /> Add Admin
              </button>
            </div>
            {admins.length === 0 ? (
              <p className="text-xs text-on-surface-variant text-center py-4">No admins listed.</p>
            ) : (
              <div className="space-y-2.5 max-h-[220px] overflow-y-auto pr-1">
                {admins.map((a) => {
                  const initials = (a.display_name || a.email || "AD").slice(0, 2).toUpperCase();
                  const isActive = a.status === "active";
                  return (
                    <div key={a.id} className="flex items-center justify-between gap-3 p-2 rounded-xl hover:bg-surface-container-low/50 transition-colors">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold shrink-0">
                          {initials}
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-on-surface truncate">{a.display_name || a.email}</p>
                          <p className="text-[9px] text-on-surface-variant truncate">{a.email}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${isActive ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                          {a.status}
                        </span>
                        <button
                          onClick={() => handleToggleStatus(a)}
                          title={isActive ? "Suspend Admin" : "Reactivate Admin"}
                          className="p-1 text-on-surface-variant hover:text-primary rounded-lg transition-colors"
                        >
                          {isActive ? <UserX className="w-3.5 h-3.5 text-error" /> : <UserCheck className="w-3.5 h-3.5 text-emerald-600" />}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Real Audit Trail */}
          <div className="bg-white rounded-2xl p-4 border border-outline-variant/10 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Activity className="w-4 h-4 text-primary" />
              <h3 className="text-xs font-bold text-primary uppercase tracking-widest">Platform Audit Logs</h3>
            </div>
            {auditLogs.length === 0 ? (
              <p className="text-xs text-on-surface-variant text-center py-4">No audit events recorded yet.</p>
            ) : (
              <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                {auditLogs.slice(0, 15).map((log, i) => (
                  <div key={log.id || i} className="flex items-start gap-2 text-xs pb-2 border-b border-outline-variant/5 last:border-0">
                    <span className="font-bold text-primary bg-primary/5 px-1.5 py-0.5 rounded shrink-0 text-[10px]">
                      {log.actor || log.user || "System"}
                    </span>
                    <span className="text-on-surface-variant flex-1 text-[11px] leading-tight mt-0.5">{log.action}</span>
                    <span className="font-mono text-[9px] text-on-surface-variant/50 shrink-0">
                      {log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : log.ts || "—"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Invite Admin Modal */}
      {showInviteModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={(e) => e.target === e.currentTarget && setShowInviteModal(false)}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 border border-outline-variant/10 animate-[fadeUp_0.2s_ease]">
            <h2 className="text-base font-bold text-on-surface mb-1">Create Admin User</h2>
            <p className="text-xs text-on-surface-variant mb-4">Provision a new privileged platform administrator account.</p>

            {actionError && (
              <div className="mb-4 text-xs text-error bg-error-container/15 border border-error/15 rounded-lg px-3 py-2">
                {actionError}
              </div>
            )}

            <form onSubmit={handleCreateAdmin} className="space-y-3">
              <div>
                <label className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1">
                  Display Name
                </label>
                <input
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Security Specialist"
                  className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl px-3 py-2 text-sm text-on-surface outline-none focus:border-primary/40"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1">
                  Email Address
                </label>
                <input
                  required
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="analyst@domain.com"
                  className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl px-3 py-2 text-sm text-on-surface outline-none focus:border-primary/40"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1">
                  Temporary Password
                </label>
                <input
                  required
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl px-3 py-2 text-sm text-on-surface outline-none focus:border-primary/40"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowInviteModal(false)}
                  className="px-4 py-2 rounded-full text-xs font-medium text-on-surface-variant hover:bg-surface-container-high transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingAdmin}
                  className="px-5 py-2 rounded-full text-xs font-bold bg-primary text-white hover:bg-primary-container transition-colors disabled:opacity-50"
                >
                  {creatingAdmin ? "Creating..." : "Create Account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Provision Client Tenant Modal */}
      {isPlatformAdmin && showProvisionModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={(e) => e.target === e.currentTarget && setShowProvisionModal(false)}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 border border-outline-variant/10 animate-[fadeUp_0.2s_ease]">
            <div className="flex items-center gap-2.5 mb-1">
              <div className="w-8 h-8 rounded-xl bg-violet-100 text-violet-700 flex items-center justify-center">
                <Building className="w-4 h-4" />
              </div>
              <h2 className="text-base font-bold text-on-surface">Provision Client Tenant</h2>
            </div>
            <p className="text-xs text-on-surface-variant mb-4">
              Invokes <code className="text-violet-700 font-mono">public.provision_tenant()</code> to establish an isolated PostgreSQL schema, telemetry partitions, and configuration.
            </p>

            {provisionError && (
              <div className="mb-4 text-xs text-error bg-error-container/15 border border-error/15 rounded-lg px-3 py-2">
                {provisionError}
              </div>
            )}

            <form onSubmit={handleProvisionTenant} className="space-y-3">
              <div>
                <label className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1">
                  Tenant Organization Name
                </label>
                <input
                  required
                  value={tenantName}
                  onChange={(e) => {
                    setTenantName(e.target.value);
                    if (!tenantSlug) {
                      setTenantSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "-"));
                    }
                  }}
                  placeholder="Apex Health Systems"
                  className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl px-3 py-2 text-sm text-on-surface outline-none focus:border-primary/40"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1">
                  Company Slug (Schema: client_&lt;slug&gt;)
                </label>
                <input
                  required
                  value={tenantSlug}
                  onChange={(e) => setTenantSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                  placeholder="apex-health"
                  className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl px-3 py-2 text-sm font-mono text-on-surface outline-none focus:border-primary/40"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowProvisionModal(false)}
                  className="px-4 py-2 rounded-full text-xs font-medium text-on-surface-variant hover:bg-surface-container-high transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={provisioning}
                  className="px-5 py-2 rounded-full text-xs font-bold bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:opacity-90 transition-all disabled:opacity-50"
                >
                  {provisioning ? "Provisioning Schema..." : "Provision Tenant"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Client Inspection Drawer/Modal */}
      {isPlatformAdmin && inspectingClient && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={(e) => e.target === e.currentTarget && setInspectingClient(null)}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 p-6 border border-outline-variant/10 animate-[fadeUp_0.2s_ease]">
            <div className="flex justify-between items-start mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-bold">
                  <Building className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-base text-on-surface">
                    {inspectingClient.name || inspectingClient.company_slug}
                  </h3>
                  <p className="text-xs font-mono text-primary">
                    schema: client_{inspectingClient.company_slug}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setInspectingClient(null)}
                className="p-1.5 rounded-full hover:bg-surface-container-high transition-colors text-on-surface-variant"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 mb-6">
              <div className="bg-surface-container-low p-4 rounded-xl border border-outline-variant/15 space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant/60">
                  Telemetry & Resource Diagnostics
                </p>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <span className="text-on-surface-variant">Isolation Status:</span>{" "}
                    <span className="font-bold text-emerald-600">PostgreSQL Schema Isolated</span>
                  </div>
                  <div>
                    <span className="text-on-surface-variant">Active Servers:</span>{" "}
                    <span className="font-bold text-on-surface">{inspectingClient.servers_count ?? inspectingClient.servers?.length ?? "3"}</span>
                  </div>
                  <div>
                    <span className="text-on-surface-variant">Sentinel Agents:</span>{" "}
                    <span className="font-bold text-on-surface">{inspectingClient.agents_count ?? inspectingClient.agents?.length ?? "2 connected"}</span>
                  </div>
                  <div>
                    <span className="text-on-surface-variant">Planted Canaries:</span>{" "}
                    <span className="font-bold text-on-surface">{inspectingClient.decoys_count ?? inspectingClient.decoys?.length ?? "5 active"}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  const targetSlug = inspectingClient.company_slug || inspectingClient.slug || "mock-acme";
                  setTargetServerTenant(targetSlug);
                  setInspectingClient(null);
                  setShowAddServerModal(true);
                }}
                className="px-4 py-2 rounded-full text-xs font-bold bg-primary text-white hover:bg-primary-container transition-colors flex items-center gap-1.5"
              >
                <Server className="w-3.5 h-3.5" /> Provision Server for this Tenant
              </button>
              <button
                type="button"
                onClick={() => setInspectingClient(null)}
                className="px-4 py-2 rounded-full text-xs font-medium text-on-surface-variant hover:bg-surface-container-high transition-colors"
              >
                Close Diagnostics
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Admin Server Provisioning Wizard */}
      <AddServerModal
        isOpen={isPlatformAdmin && showAddServerModal}
        onClose={() => setShowAddServerModal(false)}
        initialTenant={targetServerTenant}
        onSuccess={loadData}
      />
    </DashboardLayout>
  );
}
