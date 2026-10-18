"use client";

import { Loader2, Lock, ShieldCheck } from "lucide-react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { AiAnalysisWorkspace } from "@/components/ai-analysis/AiAnalysisWorkspace";
import { usePermissions } from "@/lib/rbac";

export default function AiAnalysisPage() {
  const { user, can } = usePermissions();
  const allowed = can("ai.analyze");

  return (
    <DashboardLayout>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="-tracking-wider text-2xl font-bold text-primary">AI Logs &amp; Analysis</h1>
          <p className="mt-0.5 text-xs text-on-surface-variant">Ask questions about your decoys and logs in plain language. Every claim cites a record you can verify.</p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5">
          <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden />
          <span className="text-xs font-bold text-emerald-700">Admin only · Read-only · Secrets redacted</span>
        </div>
      </header>

      {!user ? (
        <div className="flex items-center justify-center gap-2 py-24 text-xs text-on-surface-variant" role="status">
          <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden /> Checking permissions…
        </div>
      ) : !allowed ? (
        <div className="mx-auto mt-10 max-w-md rounded-2xl border border-outline-variant/10 bg-white p-8 text-center shadow-sm" role="alert">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-container-low text-on-surface-variant">
            <Lock className="h-6 w-6" aria-hidden />
          </div>
          <h2 className="text-base font-bold text-on-surface">Administrators only</h2>
          <p className="mt-1 text-xs leading-5 text-on-surface-variant">AI log analysis sends security data to an external AI service, so it is limited to administrator roles. Ask an administrator for access.</p>
        </div>
      ) : (
        <AiAnalysisWorkspace />
      )}
    </DashboardLayout>
  );
}
