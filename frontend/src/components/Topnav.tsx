"use client";

import { useState, useEffect } from "react";
import {
  Search,
  ShieldAlert,
  Radio,
  Bell,
  Menu,
  X,
  User,
  Building,
  Shield,
  Clock,
  LogOut,
} from "lucide-react";
import { checkHealth } from "@/services/healthService";
import { getSessionUser, logout, getDashboardTitle } from "@/lib/auth";
import { usePermissions } from "@/lib/rbac";

interface DecodedToken {
  sub: string;
  email: string;
  name: string;
  company_slug: string;
  iat: number;
  exp: number;
}

function decodeJwt(token: string): DecodedToken | null {
  try {
    const base64Url = token.split(".")[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(jsonPayload);
  } catch (error) {
    console.error("JWT Decode error:", error);
    return null;
  }
}

export function Topnav({ toggleSidebar, offline = false }: { toggleSidebar: () => void; offline?: boolean }) {
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [userName, setUserName] = useState("LA");
  const [userProfile, setUserProfile] = useState<DecodedToken | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [dashboardTitle, setDashboardTitle] = useState("Admin Dashboard");

  useEffect(() => {
    // Health check
    if (!offline) checkHealth()
      .then(() => setApiOnline(true))
      .catch(() => setApiOnline(false));

    // User session & token decoding
    const user = getSessionUser();
    if (user?.name) {
      const initials = user.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
      setUserName(initials || "U");
    }

    const title = getDashboardTitle();
    setDashboardTitle(title);
    if (typeof window !== "undefined") {
      document.title = `CADOC Sentinel | ${title}`;
      const token = localStorage.getItem("auth_token");
      if (token) {
        const decoded = decodeJwt(token);
        setUserProfile(decoded);
      }
    }
  }, [offline]);

  const { role, permissions, isPlatformAdmin, isTenantAdmin, isAnalyst, isReadOnly } = usePermissions();

  const handleLogout = () => {
    logout();
    window.location.href = "/login";
  };

  const isGlobalContext = userProfile?.company_slug === "global" || isPlatformAdmin;
  const displayRole = isPlatformAdmin
    ? "Global Superadmin"
    : isTenantAdmin
    ? "Tenant Administrator"
    : isAnalyst
    ? "Security Analyst"
    : "Auditor / Read-Only";

  const roleBadgeStyle = isPlatformAdmin
    ? "bg-gradient-to-r from-violet-600 to-indigo-600 text-white"
    : isTenantAdmin
    ? "bg-gradient-to-r from-cyan-600 to-primary text-white"
    : isAnalyst
    ? "bg-gradient-to-r from-amber-500 to-orange-600 text-white"
    : "bg-slate-700 text-slate-200 border border-slate-600";

  return (
    <>
      <nav
        data-tour="topnav"
        className="fixed top-0 w-full flex justify-between items-center px-4 h-16 bg-surface/70 backdrop-blur-xl z-50 shadow-[0px_24px_48px_rgba(0,27,133,0.06)] border-b border-outline-variant/20"
      >
        <div className="flex items-center gap-4">
          <button
            onClick={toggleSidebar}
            className="p-2 hover:bg-surface-container-high rounded-full transition-colors mr-2"
          >
            <Menu className="w-6 h-6 text-primary" />
          </button>
          <div className="flex items-center gap-2.5 shrink-0">
            <img
              src="/cadoc-logo-mark.png"
              alt="CADOC Sentinel"
              className="w-9 h-9 object-contain shrink-0 drop-shadow-sm select-none"
            />
            <div className="flex items-baseline gap-1.5 leading-none select-none">
              <span className="text-lg font-headline font-black tracking-tight text-[#002D80]">
                CADOC
              </span>
              <span className="text-lg font-headline font-black tracking-wider text-[#002D80]">
                SENTINEL
              </span>
            </div>
          </div>
          <span className="text-[10px] font-bold text-[#002D80] bg-[#002D80]/10 border border-[#002D80]/25 rounded-md px-2.5 py-0.5 uppercase tracking-wide shrink-0">
            {dashboardTitle}
          </span>
          <div className="h-6 w-[1px] bg-outline-variant/30 mx-2"></div>

          {/* API health indicator */}
          {apiOnline !== null && (
            <div
              data-tour="topnav-status"
              className="flex items-center gap-1.5"
              title={apiOnline ? "API Connected" : "API Offline"}
            >
              <span
                className={`w-2 h-2 rounded-full ${apiOnline ? "bg-emerald-500" : "bg-red-500"} animate-pulse`}
              />
              <span
                className={`text-[10px] font-bold uppercase tracking-wider ${apiOnline ? "text-emerald-600" : "text-red-500"}`}
              >
                {apiOnline ? "API Online" : "API Offline"}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-6">
          {/* <div className="flex items-center bg-surface-container-high px-4 py-1.5 rounded-full">
            <Search className="text-outline w-4 h-4 mr-2" />
            <input
              className="bg-transparent border-none outline-none focus:ring-0 text-sm w-48 font-body text-on-surface"
              placeholder="Search system logs..."
              type="text"
            />
          </div> */}
          <div className="flex gap-3 items-center">
            <button className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-primary/5 transition-transform active:scale-90">
              <Bell className="text-primary w-5 h-5" />
            </button>
            <button className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-primary/5 transition-transform active:scale-90">
              <ShieldAlert className="text-primary w-5 h-5" />
            </button>
            <button className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-primary/5 transition-transform active:scale-90">
              <Radio className="text-primary w-5 h-5" />
            </button>
            <button
              onClick={() => setIsPanelOpen(true)}
              className="w-8 h-8 rounded-full overflow-hidden border-2 border-primary/20 bg-surface-container-high flex items-center justify-center hover:border-primary/60 transition-all duration-200 active:scale-95"
              title="View Account Details"
            >
              <span className="text-primary font-bold text-xs">{userName}</span>
            </button>
          </div>
        </div>
      </nav>

      {/* Slide-out Backdrop Overlay */}
      {isPanelOpen && (
        <div
          onClick={() => setIsPanelOpen(false)}
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-55 transition-opacity duration-300"
        />
      )}

      {/* Right Side Panel / User Drawer */}
      <div
        className={`fixed top-0 right-0 h-full w-80 bg-surface-container-lowest/90 backdrop-blur-2xl border-l border-outline-variant/30 shadow-2xl z-60 transform transition-transform duration-300 ease-out flex flex-col ${isPanelOpen ? "translate-x-0" : "translate-x-full"
          }`}
      >
        {/* Drawer Header */}
        <div className="p-5 flex justify-between items-center border-b border-outline-variant/10">
          <h3 className="font-headline font-bold text-lg text-primary">
            Account Profile
          </h3>
          <button
            onClick={() => setIsPanelOpen(false)}
            className="p-1.5 rounded-full hover:bg-surface-container-high transition-colors text-on-surface-variant"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Drawer Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Avatar and Name */}
          <div className="text-center space-y-3">
            <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 text-primary font-headline font-bold text-xl flex items-center justify-center border-2 border-primary/20 shadow-inner">
              {userName}
            </div>
            <div>
              <h4 className="font-headline font-bold text-base text-on-surface">
                {userProfile?.name || "Bootstrap Administrator"}
              </h4>
              <p className="text-xs text-on-surface-variant break-all">
                {userProfile?.email || "admin@cadoc.io"}
              </p>
              <div className="mt-2">
                <span className="inline-block text-[10px] font-bold text-primary bg-primary/10 border border-primary/20 rounded-md px-2 py-0.5 uppercase tracking-wide">
                  {dashboardTitle}
                </span>
              </div>
            </div>

            {/* Premium Role Badge */}
            <div className="inline-block mt-2">
              <span
                className={`px-3 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase shadow-sm ${roleBadgeStyle}`}
              >
                {displayRole}
              </span>
            </div>
          </div>

          <hr className="border-outline-variant/10" />

          {/* Details Section */}
          <div className="space-y-4">
            <h5 className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant/60">
              Access Details
            </h5>

            {/* Sentinel Node */}
            <div className="flex items-center gap-3 bg-surface-container-low p-3 rounded-xl border border-outline-variant/10">
              <Building className="w-4 h-4 text-primary shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-on-surface-variant/50 uppercase leading-none">
                  Sentinel Node
                </p>
                <p className="text-xs font-semibold text-on-surface mt-1">
                  Clinical Sentinel
                </p>
              </div>
            </div>

            {/* Access Level */}
            <div className="flex items-center gap-3 bg-surface-container-low p-3 rounded-xl border border-outline-variant/10">
              <Shield className="w-4 h-4 text-primary shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-on-surface-variant/50 uppercase leading-none">
                  Access Classification
                </p>
                <p className="text-xs font-semibold text-on-surface mt-1">
                  Archival Access Level 4
                </p>
              </div>
            </div>

            {/* Tenant/Slug Info */}
            <div className="flex items-center gap-3 bg-surface-container-low p-3 rounded-xl border border-outline-variant/10">
              <Building className="w-4 h-4 text-primary shrink-0" style={{ opacity: 0.5 }} />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-on-surface-variant/50 uppercase leading-none">
                  Company Context
                </p>
                <p className="text-xs font-semibold text-on-surface mt-1 truncate">
                  {userProfile?.company_slug || "global"}
                </p>
              </div>
            </div>

            {/* User ID Info */}
            <div className="flex items-center gap-3 bg-surface-container-low p-3 rounded-xl border border-outline-variant/10">
              <User className="w-4 h-4 text-primary shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-on-surface-variant/50 uppercase leading-none">
                  User ID
                </p>
                <p className="text-[10px] font-mono text-on-surface mt-1 truncate">
                  {userProfile?.sub || "N/A"}
                </p>
              </div>
            </div>

            {/* Session Expiry Info */}
            {userProfile?.exp && (
              <div className="flex items-center gap-3 bg-surface-container-low p-3 rounded-xl border border-outline-variant/10">
                <Clock className="w-4 h-4 text-primary shrink-0" />
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-on-surface-variant/50 uppercase leading-none">
                    Session Expires
                  </p>
                  <p className="text-xs font-semibold text-on-surface mt-1">
                    {new Date(userProfile.exp * 1000).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            )}

            {/* Assigned Permissions */}
            <div className="pt-2">
              <div className="flex justify-between items-center mb-2">
                <span className="text-[10px] font-bold text-on-surface-variant/50 uppercase tracking-wider">
                  Assigned Capabilities
                </span>
                <span className="text-[9px] font-mono font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                  {permissions.includes("*") ? "ALL / Superadmin" : `${permissions.length} perms`}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {permissions.map((p) => (
                  <span
                    key={p}
                    className="text-[9px] font-mono font-semibold px-2 py-0.5 rounded-md bg-surface-container-low text-on-surface-variant border border-outline-variant/20"
                  >
                    {p === "*" ? "ALL (*)" : p}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Drawer Footer with Logout */}
        <div className="p-5 border-t border-outline-variant/10 bg-surface-container-low">
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl font-bold transition-all shadow-md hover:shadow-red-500/20 active:scale-95 text-sm cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            Log Out Session
          </button>
        </div>
      </div>
    </>
  );
}
