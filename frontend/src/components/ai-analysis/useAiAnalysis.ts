"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AiRequestError, streamAnalysis } from "@/services/aiAnalysisService";
import {
  forensicsService,
  extractChatResponseText,
  extractSqlQueryFromChat,
  buildForensicsHistoryContext,
  sanitizeForensicsResult,
} from "@/services/forensicsService";
import type { DataUsed, SseEvent } from "@/lib/ai/types";
import type { ForensicsQueryResult, ForensicsChatMessage } from "@/lib/types";

export interface ToolActivity {
  name: string;
  status: "running" | "done" | "error";
  summary: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "done" | "error" | "stopped";
  phase?: "collecting" | "analysing";
  question?: string;
  sql?: string;
  queryResult?: ForensicsQueryResult;
  dataUsed?: DataUsed;
  truncation?: string[];
  tools: ToolActivity[];
  error?: { code: string; message: string; retryAfter?: number; reason?: string };
  createdAt: number;
}

const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Owns the conversation: first message POSTs the whole scope (/query), later messages POST only
 * {session_id, message} (/followup). The server keeps the history; the scope is locked once a session exists.
 */
export function useAiAnalysis() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const sessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pendingText = useRef("");
  const rafRef = useRef<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const patch = useCallback((id: string, fn: (m: ChatMessage) => ChatMessage) => {
    if (!mounted.current) return;
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const flush = useCallback(
    (id: string) => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const text = pendingText.current;
      pendingText.current = "";
      if (text) patch(id, (m) => ({ ...m, content: m.content + text, phase: "analysing" }));
    },
    [patch]
  );

  const send = useCallback(
    async (question: string, queryBody: object | null): Promise<void> => {
      if (busy) return;
      const isFollowup = sessionRef.current !== null && locked;
      const body = isFollowup ? { session_id: sessionRef.current, message: question } : queryBody;
      if (!body) return;

      const asstId = uid();
      setNotice(null);
      const newUserMsg: ChatMessage = { id: uid(), role: "user", content: question, status: "done", tools: [], createdAt: Date.now() };
      const newAsstMsg: ChatMessage = { id: asstId, role: "assistant", content: "", status: "streaming", phase: "collecting", question, tools: [], createdAt: Date.now() };

      if (!isFollowup) {
        setMessages([newUserMsg, newAsstMsg]);
      } else {
        setMessages((prev) => [...prev, newUserMsg, newAsstMsg]);
      }
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;

      const onEvent = (e: SseEvent) => {
        switch (e.type) {
          case "meta":
            sessionRef.current = e.session_id;
            if (mounted.current) setLocked(true);
            patch(asstId, (m) => ({ ...m, dataUsed: e.data_used, truncation: e.truncation, phase: "analysing" }));
            break;
          case "data_used":
            patch(asstId, (m) => ({ ...m, dataUsed: e.data_used, truncation: e.truncation }));
            break;
          case "tool":
            patch(asstId, (m) => {
              const tools = [...m.tools];
              const i = tools.findIndex((t) => t.name === e.name && t.status === "running");
              const next = { name: e.name, status: e.status, summary: e.summary };
              if (e.status === "running" || i < 0) tools.push(next);
              else tools[i] = next;
              return { ...m, tools };
            });
            break;
          case "delta":
            pendingText.current += e.text;
            if (rafRef.current === null) rafRef.current = requestAnimationFrame(() => flush(asstId));
            break;
          case "done":
            flush(asstId);
            patch(asstId, (m) => ({ ...m, status: "done", phase: undefined }));
            break;
          case "error":
            flush(asstId);
            if (!isFollowup) {
              sessionRef.current = null; // the server discards a failed first turn
              if (mounted.current) setLocked(false);
            }
            patch(asstId, (m) => ({ ...m, status: "error", phase: undefined, error: { code: e.code, message: e.message } }));
            break;
        }
      };

      try {
        await streamAnalysis(isFollowup ? "followup" : "query", body, { signal: ac.signal, onEvent });
      } catch (err) {
        flush(asstId);
        if ((err as { name?: string })?.name === "AbortError") {
          if (!isFollowup) {
            sessionRef.current = null;
            if (mounted.current) setLocked(false);
          }
          patch(asstId, (m) => ({ ...m, status: "stopped", phase: undefined }));
        } else {
          const e = err instanceof AiRequestError ? err : new AiRequestError("internal_error", "Something went wrong. Please try again.");
          if (e.code === "session_not_found") {
            sessionRef.current = null;
            if (mounted.current) {
              setLocked(false);
              setNotice("That conversation expired on the server. Your next question will start a fresh analysis with the scope on the left.");
            }
          }
          patch(asstId, (m) => ({ ...m, status: "error", phase: undefined, error: { code: e.code, message: e.message, retryAfter: e.retryAfter, reason: e.reason } }));
        }
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        if (mounted.current) setBusy(false);
      }
    },
    [busy, flush, patch]
  );

  const activeProjectIdRef = useRef<string | null>(null);
  const activeSqlRef = useRef<string | null>(null);
  const activeResultRef = useRef<ForensicsQueryResult | null>(null);

  const sendProjectForensics = useCallback(
    async (params: {
      projectId: string;
      sql?: string;
      userPrompt: string;
      filterRange?: string;
      isFollowup?: boolean;
    }): Promise<void> => {
      if (busy) return;
      const { projectId, sql, userPrompt, filterRange } = params;
      const isFollowup = params.isFollowup ?? locked;
      const asstId = uid();
      setNotice(null);

      // On a new analysis (or project change), clear all previous records & cached query results
      if (!isFollowup || activeProjectIdRef.current !== projectId) {
        activeProjectIdRef.current = projectId;
        activeResultRef.current = null;
        activeSqlRef.current = null;
      }
      if (sql) {
        activeSqlRef.current = sql;
      }

      const priorResult = isFollowup ? activeResultRef.current : null;
      const priorSql = isFollowup ? activeSqlRef.current : (sql || null);

      const newUserMsg: ChatMessage = {
        id: uid(),
        role: "user",
        content: userPrompt,
        status: "done",
        tools: [],
        createdAt: Date.now(),
      };

      const newAsstMsg: ChatMessage = {
        id: asstId,
        role: "assistant",
        content: "",
        status: "streaming",
        phase: "collecting",
        question: userPrompt,
        sql: priorSql || undefined,
        tools: [
          {
            name: "forensics_chat",
            status: "running",
            summary: priorResult
              ? `Sending inquiry with stored query evidence (${priorResult.rows.length} records) to Forensics AI Chat…`
              : "Calling Forensics AI Chat to generate query (Swagger Step 1)…",
          },
        ],
        createdAt: Date.now(),
      };

      // If new analysis, replace all previous messages; if follow-up, append to history
      if (!isFollowup) {
        setMessages([newUserMsg, newAsstMsg]);
      } else {
        setMessages((prev) => [...prev, newUserMsg, newAsstMsg]);
      }

      setBusy(true);
      setLocked(true);

      // Extract existing forensics conversation history (up to 19 completed messages)
      const prevForensicsHistory: ForensicsChatMessage[] = [];
      if (isFollowup) {
        for (const m of messages) {
          if (m.status !== "done") continue;
          if (m.role === "user") {
            prevForensicsHistory.push({
              role: "user",
              content: m.content.slice(0, 4000),
            });
          } else if (m.role === "assistant") {
            prevForensicsHistory.push({
              role: "assistant",
              content: (m.content || "").slice(0, 4000),
              ...(m.sql ? { sql: m.sql.slice(0, 8000) } : {}),
              ...(m.queryResult ? { result: sanitizeForensicsResult(m.queryResult) } : {}),
            });
          }
        }
      }

      try {
        const contextualPrompt = filterRange
          ? `${userPrompt}\n[Time Filter Range: ${filterRange}]`
          : userPrompt;

        // Build user message containing the last queried result (e.g. 24h summary) & SQL if available
        const userMsgToSend: ForensicsChatMessage = {
          role: "user",
          content: contextualPrompt,
          ...(priorSql ? { sql: priorSql } : {}),
          ...(priorResult ? { result: sanitizeForensicsResult(priorResult) } : {}),
        };

        const messagesToSend = buildForensicsHistoryContext(
          prevForensicsHistory,
          userMsgToSend
        );

        // Step 1: Call Forensics AI Chat first (sending previous query evidence if present)
        const chatRes = await forensicsService.chat(projectId, {
          messages: messagesToSend,
        });

        const chatText = extractChatResponseText(chatRes);
        let generatedSql: string | null = null;
        try {
          generatedSql = extractSqlQueryFromChat(chatRes, priorSql || undefined);
        } catch {
          generatedSql = null;
        }

        // Step 2: If chat generated a query, execute it via Query API and store the result for next turn
        if (generatedSql) {
          patch(asstId, (m) => ({
            ...m,
            content: chatText || "Forensics AI Chat formulated query.",
            sql: generatedSql,
            phase: "analysing",
            tools: [
              {
                name: "forensics_chat",
                status: "done" as const,
                summary: "Forensics AI Chat formulated targeted query",
              },
              {
                name: "forensics_query",
                status: "running" as const,
                summary: "Executing generated query via Forensics Query API to generate summary…",
              },
            ],
          }));

          const queryResult = await forensicsService.query(projectId, { sql: generatedSql });
          // Store result & SQL in active refs so next user question receives them in chat payload
          activeResultRef.current = queryResult;
          activeSqlRef.current = generatedSql;

          patch(asstId, (m) => ({
            ...m,
            content: chatText || "Forensics query executed successfully.",
            sql: generatedSql,
            queryResult,
            status: "done",
            phase: undefined,
            tools: [
              {
                name: "forensics_chat",
                status: "done" as const,
                summary: "Forensics AI Chat formulated targeted query",
              },
              {
                name: "forensics_query",
                status: "done" as const,
                summary: `Generated summary evidence (${queryResult.rows.length} records)`,
              },
            ],
          }));
        } else {
          patch(asstId, (m) => ({
            ...m,
            content: chatText || "Forensics analysis completed.",
            status: "done",
            phase: undefined,
            tools: [
              {
                name: "forensics_chat",
                status: "done" as const,
                summary: "Forensics AI Chat responded",
              },
            ],
          }));
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : "Forensics pipeline failed";
        patch(asstId, (m) => ({
          ...m,
          status: "error",
          phase: undefined,
          error: { code: "forensics_error", message: errorMsg },
        }));
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [busy, patch]
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    sessionRef.current = null;
    activeProjectIdRef.current = null;
    activeSqlRef.current = null;
    activeResultRef.current = null;
    pendingText.current = "";
    setMessages([]);
    setLocked(false);
    setNotice(null);
    setBusy(false);
  }, []);

  /** Drops the last user+assistant pair so the same question can be re-sent cleanly. */
  const dropLastTurn = useCallback(() => setMessages((prev) => prev.slice(0, -2)), []);

  return {
    messages,
    busy,
    locked,
    notice,
    send,
    sendProjectForensics,
    activeProjectId: activeProjectIdRef.current,
    stop,
    reset,
    dropLastTurn,
  };
}
