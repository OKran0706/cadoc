"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { logout, getDashboardTitle } from "@/lib/auth";
import { usePermissions } from "@/lib/rbac";
import type { Permission } from "@/lib/types";
import { useState, useEffect } from "react";
import {
  LayoutDashboard, BellRing, FileText,
  Server, Shield, HelpCircle, LogOut,
  SlidersHorizontal, Bot, KeyRound, Orbit, Sparkles,
} from "lucide-react";

const navMain: { href: string; icon: typeof FileText; label: string; permission?: Permission }[] = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/events", icon: BellRing, label: "Events" },
  { href: "/ai-analysis", icon: Sparkles, label: "AI Analysis", permission: "ai.analyze" },
  { href: "/infrastructure", icon: Server, label: "Infrastructure" },
  { href: "/holistic", icon: Orbit, label: "Holistic View" },
  { href: "/agents", icon: Bot, label: "Agents" },
  { href: "/keys", icon: KeyRound, label: "API Keys" },
  { href: "/admin", icon: Shield, label: "Admin" },
  { href: "/settings", icon: SlidersHorizontal, label: "Settings" },
];



export function Sidebar({ isOpen }: { isOpen: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const [dashboardTitle, setDashboardTitle] = useState("Admin Dashboard");
  const { can } = usePermissions();

  useEffect(() => {
    setDashboardTitle(getDashboardTitle());
  }, []);

  const linkClass = (href: string) => {
    const active = pathname === href;
    const base = `rounded-full py-3 flex items-center transition-all duration-300 ${isOpen ? "mx-2 px-6 gap-4" : "mx-4 px-0 justify-center w-12 h-12"}`;
    return active
      ? `${base} bg-primary text-white shadow-lg shadow-primary/20`
      : `${base} text-on-surface-variant hover:text-primary hover:bg-surface-container-high`;
  };



  return (
    <aside
      data-tour="sidebar"
      className={`fixed left-0 top-16 h-[calc(100vh-64px)] bg-surface-container-low flex flex-col py-6 z-40 rounded-r-xl shadow-[4px_0px_24px_rgba(0,0,0,0.02)] transition-all duration-300 overflow-x-hidden overflow-y-auto ${isOpen ? "w-64" : "w-20"
        }`}
    >
      <div className={`mb-6 whitespace-nowrap transition-all duration-300 ${isOpen ? "px-6 opacity-100" : "px-0 opacity-0 hidden"}`}>
        <p className="text-xs font-bold text-primary tracking-widest uppercase mb-1">Clinical Sentinel</p>
        <p className="text-[10px] text-on-surface-variant uppercase mb-2">Archival Access Level 4</p>
        <span className="inline-block text-[9px] font-bold text-primary bg-primary/10 border border-primary/20 rounded-md px-1.5 py-0.5 uppercase tracking-wider">
          {dashboardTitle}
        </span>
      </div>

      <nav className="flex-1 space-y-1">
        {/* Main Nav */}
        {navMain.filter((item) => !item.permission || can(item.permission)).map(({ href, icon: Icon, label }) => (
          <Link
            key={href}
            href={href}
            data-tour={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
            className={linkClass(href)}
          >
            <Icon className="w-5 h-5 shrink-0" />
            {isOpen && <span className="font-medium text-sm whitespace-nowrap">{label}</span>}
          </Link>
        ))}


      </nav>

      <div className="mt-auto space-y-1">

        <a className={`text-on-surface-variant hover:text-primary hover:bg-surface-container-high rounded-full py-2 flex items-center transition-all duration-300 ${isOpen ? "mx-2 px-6 gap-4" : "mx-4 px-0 justify-center w-12 h-12"}`} href="#">
          <HelpCircle className="w-5 h-5 shrink-0" />
          {isOpen && <span className="font-medium text-sm whitespace-nowrap">Support</span>}
        </a>
        <button
          onClick={(e) => {
            e.preventDefault();
            logout();
            router.push("/login");
          }}
          className={`w-full text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-full py-2 flex items-center transition-all duration-300 ${isOpen ? "mx-2 px-6 gap-4" : "mx-4 px-0 justify-center w-12 h-12"}`}
        >
          <LogOut className="w-5 h-5 shrink-0" />
          {isOpen && <span className="font-medium text-sm whitespace-nowrap">Logout</span>}
        </button>
      </div>
    </aside>
  );
}
