"use client";

import { useState } from "react";
import {
  Calendar,
  Database,
  Filter,
  FolderKanban,
  Layers,
  Lock,
  Play,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
} from "lucide-react";
import { ServerMultiSelect } from "./ServerMultiSelect";
import { SOURCES } from "@/lib/ai/types";
import {
  DECOY_STATUSES,
  DECOY_TYPES,
  MAX_SERVERS,
  PRESETS,
  SOURCE_META,
} from "@/lib/aiScope";
import type { PresetId, ScopeState } from "@/lib/aiScope";
import type { ProjectResponse, ServerResponse } from "@/lib/types";
import { generateForensicsSql } from "@/services/forensicsService";

interface Props {
  projects?: ProjectResponse[];
  projectsLoading?: boolean;
  projectsError?: string | null;
  onRetryProjects?: () => void;
  servers: ServerResponse[];
  serversLoading: boolean;
  serversError: string | null;
  onRetryServers: () => void;
  scope: ScopeState;
  onChange: (next: ScopeState) => void;
  errors: string[];
  locked: boolean;
  onNewAnalysis: () => void;
  onRunForensics?: (prompt?: string) => void;
  isForensicsBusy?: boolean;
}

const sectionTitle =
  "mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-primary";
const fieldClass =
  "w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest px-2.5 py-2 text-xs text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60";

export function ScopePanel({
  projects = [],
  projectsLoading = false,
  projectsError = null,
  onRetryProjects,
  servers,
  serversLoading,
  serversError,
  onRetryServers,
  scope,
  onChange,
  errors,
  locked,
  onNewAnalysis,
  onRunForensics,
  isForensicsBusy = false,
}: Props) {
  const [showSqlEditor, setShowSqlEditor] = useState(false);
  const [analysisPrompt, setAnalysisPrompt] = useState("");

  const set = (patch: Partial<ScopeState>) => onChange({ ...scope, ...patch });
  const toggleSource = (s: (typeof SOURCES)[number]) =>
    set({
      sources: scope.sources.includes(s)
        ? scope.sources.filter((x) => x !== s)
        : [...scope.sources, s],
    });

  const selectedProject = projects.find((p) => p.id === scope.projectId);
  const hostnames = scope.serverIds.map(
    (id) => servers.find((s) => s.id === id)?.hostname ?? id
  );
  const presetLabel =
    scope.preset === "custom"
      ? "Custom range"
      : `Last ${PRESETS.find((p) => p.id === scope.preset)?.label}`;

  const currentSql =
    scope.customSql ||
    (scope.projectId
      ? generateForensicsSql({
          projectId: scope.projectId,
          preset: scope.preset === "custom" ? undefined : scope.preset,
          customFrom: scope.preset === "custom" ? scope.customFrom : undefined,
          customTo: scope.preset === "custom" ? scope.customTo : undefined,
          severity: scope.severity,
        })
      : "");

  if (locked) {
    return (
      <aside
        className="flex h-full flex-col rounded-2xl border border-outline-variant/10 bg-white p-4 shadow-sm"
        aria-label="Analysis scope (locked)"
      >
        <div className="mb-3 flex items-center gap-2">
          <Lock className="h-3.5 w-3.5 text-primary" />
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-primary">
            Scope · locked
          </h2>
        </div>
        <p className="mb-4 text-[11px] leading-5 text-on-surface-variant">
          Follow-up questions use this scope. Start a new analysis to change
          project, filters, or sources.
        </p>

        <dl className="space-y-3 text-xs">
          {scope.projectId && (
            <div>
              <dt className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                Target Project
              </dt>
              <dd className="mt-1 font-semibold text-primary">
                {selectedProject?.name ?? scope.projectId}
              </dd>
            </div>
          )}

          <div>
            <dt className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
              Time range
            </dt>
            <dd className="mt-1 text-on-surface">{presetLabel}</dd>
          </div>

          {scope.mode !== "project_forensics" && (
            <>
              <div>
                <dt className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                  Servers
                </dt>
                <dd className="mt-1 flex flex-wrap gap-1">
                  {hostnames.map((h) => (
                    <span
                      key={h}
                      className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary"
                    >
                      {h}
                    </span>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                  Sources
                </dt>
                <dd className="mt-1 text-on-surface">
                  {scope.sources.map((s) => SOURCE_META[s].label).join(", ")}
                </dd>
              </div>
            </>
          )}

          {scope.severity && (
            <div>
              <dt className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                Severity Filter
              </dt>
              <dd className="mt-1 font-mono text-[11px] text-error font-bold">
                {scope.severity}
              </dd>
            </div>
          )}
        </dl>

        <button
          type="button"
          onClick={() => {
            setAnalysisPrompt("");
            onNewAnalysis();
          }}
          className="mt-auto flex items-center justify-center gap-2 rounded-full border border-primary/25 px-4 py-2 text-xs font-bold text-primary transition-colors hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <Plus className="h-3.5 w-3.5" /> New analysis
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="flex h-full flex-col gap-4 overflow-y-auto rounded-2xl border border-outline-variant/10 bg-white p-4 shadow-sm"
      aria-label="Analysis scope"
    >
      {/* Mode Switcher Tabs */}
      <div className="flex rounded-xl bg-surface-container-low p-1">
        <button
          type="button"
          onClick={() => set({ mode: "project_forensics" })}
          className={`flex-1 rounded-lg py-1.5 text-[11px] font-bold transition-all ${
            scope.mode === "project_forensics"
              ? "bg-white text-primary shadow-sm"
              : "text-on-surface-variant hover:text-on-surface"
          }`}
        >
          Project Forensics
        </button>
        <button
          type="button"
          onClick={() => set({ mode: "servers" })}
          className={`flex-1 rounded-lg py-1.5 text-[11px] font-bold transition-all ${
            scope.mode === "servers"
              ? "bg-white text-primary shadow-sm"
              : "text-on-surface-variant hover:text-on-surface"
          }`}
        >
          Server Logs
        </button>
      </div>

      {/* ─── 1. Project Selection ─── */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <h2 className={sectionTitle}>
            <FolderKanban className="h-3.5 w-3.5" /> Project
          </h2>
          {projectsLoading && (
            <span className="text-[10px] text-primary animate-pulse">Loading…</span>
          )}
        </div>

        {projectsError ? (
          <div className="rounded-xl border border-error/20 bg-error/5 p-2.5 text-xs text-error flex items-center justify-between">
            <span>Failed to load projects</span>
            {onRetryProjects && (
              <button
                type="button"
                onClick={onRetryProjects}
                className="text-[10px] font-bold underline flex items-center gap-1"
              >
                <RefreshCw className="h-3 w-3" /> Retry
              </button>
            )}
          </div>
        ) : (
          <div>
            <select
              value={scope.projectId}
              onChange={(e) => {
                const nextId = e.target.value;
                set({
                  projectId: nextId,
                  // Auto-filter servers belonging to this project
                  serverIds: servers
                    .filter((s) => s.project_id === nextId)
                    .map((s) => s.id),
                  customSql: "", // reset custom SQL to regenerate for new project
                });
              }}
              className={fieldClass}
            >
              <option value="">-- Select a project --</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.description ? `(${p.description})` : ""}
                </option>
              ))}
            </select>

            {selectedProject && (
              <div className="mt-1 flex items-center justify-between text-[10px] text-on-surface-variant px-1 font-mono">
                <span>ID: {selectedProject.id.slice(0, 13)}…</span>
                <span className="rounded bg-emerald-50 text-emerald-700 px-1.5 py-0.2 font-sans font-semibold">
                  Active
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ─── 2. Filter & Time Range ─── */}
      <section>
        <h2 className={sectionTitle}>
          <Calendar className="h-3.5 w-3.5" /> Filter Range
        </h2>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Time range">
          {[
            ...PRESETS.map((p) => ({ id: p.id as PresetId, label: p.label })),
            { id: "custom" as PresetId, label: "Custom" },
          ].map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={scope.preset === p.id}
              onClick={() => set({ preset: p.id, customSql: "" })}
              className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                scope.preset === p.id
                  ? "bg-primary text-white shadow shadow-primary/20"
                  : "bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {scope.preset === "custom" && (
          <div className="mt-3 grid grid-cols-1 gap-2">
            <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
              From
              <input
                type="datetime-local"
                value={scope.customFrom}
                onChange={(e) => set({ customFrom: e.target.value, customSql: "" })}
                className={`${fieldClass} mt-1 font-normal normal-case tracking-normal`}
              />
            </label>
            <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
              To
              <input
                type="datetime-local"
                value={scope.customTo}
                onChange={(e) => set({ customTo: e.target.value, customSql: "" })}
                className={`${fieldClass} mt-1 font-normal normal-case tracking-normal`}
              />
            </label>
          </div>
        )}
      </section>

      {/* ─── 3. Severity & Status Filters ─── */}
      <section>
        <h2 className={sectionTitle}>
          <Filter className="h-3.5 w-3.5" /> Event Filters
        </h2>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
            Severity
            <select
              value={scope.severity || ""}
              onChange={(e) => set({ severity: e.target.value, customSql: "" })}
              className={`${fieldClass} mt-1 font-normal normal-case tracking-normal`}
            >
              <option value="">All Severities</option>
              <option value="CRIT">Critical (CRIT)</option>
              <option value="WARN">Warning (WARN)</option>
              <option value="INFO">Info (INFO)</option>
            </select>
          </label>

          <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
            Decoy Status
            <select
              value={scope.status}
              onChange={(e) => set({ status: e.target.value, customSql: "" })}
              className={`${fieldClass} mt-1 font-normal normal-case tracking-normal`}
            >
              <option value="">Any Status</option>
              {DECOY_STATUSES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* ─── Mode Specific: Servers & Sources (if mode === 'servers') ─── */}
      {scope.mode === "servers" && (
        <>
          <section>
            <h2 className={sectionTitle}>
              <Server className="h-3.5 w-3.5" /> Servers
            </h2>
            <ServerMultiSelect
              servers={servers}
              selected={scope.serverIds}
              onChange={(serverIds) => set({ serverIds })}
              max={MAX_SERVERS}
              loading={serversLoading}
              error={serversError}
              onRetry={onRetryServers}
              hasError={errors.some((e) => /server/i.test(e))}
            />
          </section>

          <section>
            <h2 className={sectionTitle}>
              <Layers className="h-3.5 w-3.5" /> Data Sources
            </h2>
            <ul className="space-y-1.5">
              {SOURCES.map((s) => (
                <li key={s}>
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-xl p-2 transition-colors hover:bg-surface-container-low">
                    <input
                      type="checkbox"
                      checked={scope.sources.includes(s)}
                      onChange={() => toggleSource(s)}
                      className="mt-0.5 h-3.5 w-3.5 accent-[#001b85]"
                    />
                    <span>
                      <span className="block text-xs font-semibold text-on-surface">
                        {SOURCE_META[s].label}
                      </span>
                      <span className="block text-[10px] leading-4 text-on-surface-variant">
                        {SOURCE_META[s].hint}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {/* ─── 4. Forensics SQL Query Editor (Swagger API 1) ─── */}
      {scope.mode === "project_forensics" && (
        <section className="rounded-xl border border-outline-variant/15 bg-surface-container-low/50 p-3">
          <div className="flex items-center justify-between mb-2">
            <h2 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-primary">
              <Database className="h-3.5 w-3.5" /> Forensics SQL (API 1)
            </h2>
            <button
              type="button"
              onClick={() => setShowSqlEditor((prev) => !prev)}
              className="text-[10px] font-semibold text-primary hover:underline"
            >
              {showSqlEditor ? "Hide SQL" : "View/Edit SQL"}
            </button>
          </div>

          {showSqlEditor ? (
            <div className="space-y-2">
              <textarea
                value={currentSql}
                onChange={(e) => set({ customSql: e.target.value })}
                rows={4}
                className="w-full rounded-lg border border-outline-variant/30 bg-[#0a111e] p-2 font-mono text-[11px] text-emerald-400 focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder="SELECT ... FROM sentinel_logs WHERE ..."
              />
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-on-surface-variant">
                  Max 8000 characters
                </span>
                {scope.customSql && (
                  <button
                    type="button"
                    onClick={() => set({ customSql: "" })}
                    className="text-primary hover:underline font-semibold"
                  >
                    Reset to generated SQL
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-on-surface-variant leading-relaxed">
              Forensics AI Chat (<code className="font-mono text-primary font-bold">/forensics/chat</code>) analyzes your inquiry first to generate a tailored SQL query, which is then executed against{" "}
              <code className="font-mono text-primary font-bold">/forensics/query</code> to retrieve live database evidence.
            </p>
          )}

          {/* User Analysis Prompt Input */}
          <div className="mt-3">
            <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant block mb-1">
              Analysis Question / Inquiry
            </label>
            <input
              type="text"
              value={analysisPrompt}
              onChange={(e) => setAnalysisPrompt(e.target.value)}
              placeholder="e.g. Investigate critical authentication errors and decoy tampering"
              className="w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest px-2.5 py-2 text-xs text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
          </div>

          {/* Action Trigger Button */}
          {onRunForensics && (
            <button
              type="button"
              disabled={isForensicsBusy || !scope.projectId}
              onClick={() => {
                const promptToRun = analysisPrompt.trim();
                if (promptToRun) {
                  onRunForensics(promptToRun);
                  setAnalysisPrompt("");
                }
              }}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-xs font-bold text-white shadow-md shadow-primary/20 transition-all hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
            >
              {isForensicsBusy ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  <span>Executing Pipeline…</span>
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5 fill-current" />
                  <span>Run Forensics AI &amp; Query</span>
                </>
              )}
            </button>
          )}
        </section>
      )}

      {/* Validation Errors */}
      {errors.length > 0 && (
        <ul
          className="rounded-xl border border-error/20 bg-error/5 p-3 text-[11px] text-error"
          role="alert"
        >
          {errors.map((e) => (
            <li key={e}>• {e}</li>
          ))}
        </ul>
      )}
    </aside>
  );
}
