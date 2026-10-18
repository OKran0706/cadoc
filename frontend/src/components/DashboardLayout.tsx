"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Topnav } from "@/components/Topnav";
import { Sidebar } from "@/components/Sidebar";
import { SentinelGuide } from "@/components/SentinelGuide";
import { isAuthenticated } from "@/lib/auth";

export function DashboardLayout({ children, offline = false }: { children: React.ReactNode; offline?: boolean }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
    } else {
      Promise.resolve().then(() => {
        setAuthChecked(true);
      });
    }
  }, [router]);

  if (!authChecked) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-surface text-primary">
        <div className="flex flex-col items-center gap-3">
          <span className="w-8 h-8 border-3 border-primary/20 border-t-primary rounded-full animate-spin" />
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-on-surface-variant/60">
            Verifying Security Session...
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Topnav offline={offline} toggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)} />
      <Sidebar isOpen={isSidebarOpen} />
      <main
        className={`mt-16 p-5 overflow-y-auto h-[calc(100vh-64px)] scroll-smooth bg-surface transition-all duration-300 ${
          isSidebarOpen ? "ml-64 w-[calc(100%-16rem)]" : "ml-20 w-[calc(100%-5rem)]"
        }`}
      >
        {children}
      </main>
      <SentinelGuide />
    </>
  );
}
