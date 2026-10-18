"use client";

import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "./ChatPanel";
import { ScopePanel } from "./ScopePanel";
import { useAiAnalysis } from "./useAiAnalysis";
import { defaultScope, toQueryBody, validateScope } from "@/lib/aiScope";
import type { ScopeState } from "@/lib/aiScope";
import { serverService } from "@/services/serverService";
import { projectService } from "@/services/projectService";
import { generateForensicsSql } from "@/services/forensicsService";
import type { ProjectResponse, ServerResponse } from "@/lib/types";

export function AiAnalysisWorkspace() {
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  const [servers, setServers] = useState<ServerResponse[]>([]);
  const [serversLoading, setServersLoading] = useState(true);
  const [serversError, setServersError] = useState<string | null>(null);
  const [scope, setScope] = useState<ScopeState>(defaultScope);
  // Validation messages are computed in event handlers (never during render) and only once the admin tried to send.
  const [errors, setErrors] = useState<string[]>([]);
  const ai = useAiAnalysis();

  const fetchProjects = useCallback(() => {
    setProjectsLoading(true);
    return projectService
      .listProjects()
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setProjects(list);
        setProjectsError(null);
        if (list.length > 0) {
          setScope((s) => ({
            ...s,
            projectId: s.projectId || list[0].id,
            mode: s.projectId ? s.mode : "project_forensics",
          }));
        }
      })
      .catch((err: Error) => setProjectsError(err.message || "Failed to load projects"))
      .finally(() => setProjectsLoading(false));
  }, []);

  const fetchServers = useCallback(() => {
    return serverService
      .listServers()
      .then((data) => {
        const list = (Array.isArray(data) ? data : []).slice().sort((a, b) => a.hostname.localeCompare(b.hostname));
        setServers(list);
        setServersError(null);
        // one server: nothing to choose, so preselect it
        if (list.length === 1) setScope((s) => (s.serverIds.length ? s : { ...s, serverIds: [list[0].id] }));
      })
      .catch((err: Error) => setServersError(err.message || "Request failed"))
      .finally(() => setServersLoading(false));
  }, []);

  useEffect(() => {
    void fetchProjects();
    void fetchServers();
  }, [fetchProjects, fetchServers]);

  const retryProjects = useCallback(() => {
    void fetchProjects();
  }, [fetchProjects]);

  const retryServers = useCallback(() => {
    setServersLoading(true);
    setServersError(null);
    void fetchServers();
  }, [fetchServers]);

  const changeScope = useCallback(
    (next: ScopeState) => {
      // Whenever project or mode changes, clear all previous records
      if (next.projectId !== scope.projectId || next.mode !== scope.mode) {
        ai.reset();
      }
      setScope(next);
      if (errors.length) setErrors(validateScope(next, Date.now()));
    },
    [scope.projectId, scope.mode, ai, errors.length]
  );

  const runProjectForensicsPipeline = useCallback(
    (userPrompt?: string, isFollowup = false) => {
      if (!scope.projectId) {
        setErrors(["Select a project for forensics analysis."]);
        return;
      }
      const prompt = (userPrompt || "").trim();
      if (!prompt) {
        setErrors(["Please enter an inquiry or question for the AI to analyze."]);
        return;
      }
      setErrors([]);
      const customSql = scope.customSql ? scope.customSql.trim() : undefined;

      const baseFilter =
        scope.preset === "custom"
          ? `${scope.customFrom || "start"} to ${scope.customTo || "now"}`
          : scope.preset;
      const filterRange =
        scope.severity && scope.severity !== "ALL"
          ? `${baseFilter} (Severity: ${scope.severity})`
          : baseFilter;

      void ai.sendProjectForensics({
        projectId: scope.projectId,
        sql: customSql,
        userPrompt: prompt,
        filterRange,
        isFollowup,
      });
    },
    [scope, ai]
  );

  const send = useCallback(
    (question: string, chipRange?: "24h") => {
      const text = question.trim();
      if (!text) return;
      if (ai.locked) {
        if (scope.mode === "project_forensics" && scope.projectId) {
          runProjectForensicsPipeline(text, true);
          return;
        }
        void ai.send(text, null);
        return;
      }

      if (scope.mode === "project_forensics") {
        if (!scope.projectId) {
          setErrors(["Select a project for forensics analysis."]);
          return;
        }
        setErrors([]);
        runProjectForensicsPipeline(text, false);
        return;
      }

      const effective: ScopeState = chipRange ? { ...scope, preset: chipRange } : scope;
      const found = validateScope(effective, Date.now());
      if (found.length > 0) {
        setErrors(found);
        return;
      }
      if (chipRange) setScope(effective);
      setErrors([]);
      void ai.send(text, toQueryBody(effective, text, Date.now()));
    },
    [ai, scope, runProjectForensicsPipeline]
  );

  const retry = useCallback(() => {
    const last = [...ai.messages].reverse().find((m) => m.role === "assistant");
    if (!last?.question) return;
    ai.dropLastTurn();
    send(last.question);
  }, [ai, send]);

  const newAnalysis = useCallback(() => {
    ai.reset();
    setErrors([]);
    setScope((prev) => ({
      ...prev,
      customSql: "",
    }));
  }, [ai]);

  const exampleServer =
    servers.find((s) => s.id === scope.serverIds[0])?.hostname ?? servers[0]?.hostname ?? null;

  return (
    <div className="grid grid-cols-1 gap-5 lg:h-[calc(100vh-200px)] lg:min-h-[540px] lg:grid-cols-12">
      <div className="min-h-0 lg:col-span-4 xl:col-span-3">
        <ScopePanel
          projects={projects}
          projectsLoading={projectsLoading}
          projectsError={projectsError}
          onRetryProjects={retryProjects}
          servers={servers}
          serversLoading={serversLoading}
          serversError={serversError}
          onRetryServers={retryServers}
          scope={scope}
          onChange={changeScope}
          errors={errors}
          locked={ai.locked}
          onNewAnalysis={newAnalysis}
          onRunForensics={runProjectForensicsPipeline}
          isForensicsBusy={ai.busy}
        />
      </div>
      <div className="min-h-[70vh] lg:col-span-8 lg:min-h-0 xl:col-span-9">
        <ChatPanel
          messages={ai.messages}
          busy={ai.busy}
          locked={ai.locked}
          notice={ai.notice}
          exampleServer={exampleServer}
          onSend={send}
          onStop={ai.stop}
          onRetry={retry}
          onNewAnalysis={newAnalysis}
        />
      </div>
    </div>
  );
}
