"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Info, Lock, MessageSquare, Plus, Send, ShieldCheck, Sparkles, Square } from "lucide-react";
import { MessageBubble } from "./MessageBubble";
import { MAX_MESSAGE_CHARS, PROMPT_CHIPS } from "@/lib/aiScope";
import type { ChatMessage } from "./useAiAnalysis";

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  locked: boolean;
  notice: string | null;
  exampleServer: string | null;
  onSend: (question: string, chipRange?: "24h") => void;
  onStop: () => void;
  onRetry: () => void;
  onNewAnalysis: () => void;
}

export function ChatPanel({ messages, busy, locked, notice, exampleServer, onSend, onStop, onRetry, onNewAnalysis }: Props) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToEnd = useCallback((smooth = false) => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setShowJump(!stick.current);
  };

  useEffect(() => {
    if (stick.current) scrollToEnd();
  }, [messages, scrollToEnd]);

  // grow the textarea with its content (max ~6 lines)
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`;
  }, [draft]);

  const submit = () => {
    const q = draft.trim();
    if (!q || busy || q.length > MAX_MESSAGE_CHARS) return;
    stick.current = true;
    onSend(q);
    setDraft("");
  };

  const sendChip = (prompt: string, isFirst: boolean) => {
    if (busy) return;
    stick.current = true;
    onSend(prompt, isFirst ? "24h" : undefined);
  };

  const empty = messages.length === 0;
  const over = draft.length > MAX_MESSAGE_CHARS;
  const placeholder = locked ? "Ask a follow-up about this analysis…" : `e.g. What happened on ${exampleServer ?? "pikachu"} in the last 2 hours?`;

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-outline-variant/10 bg-white shadow-sm" aria-label="AI analysis conversation">
      <header className="flex items-center justify-between gap-3 border-b border-outline-variant/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <h2 className="truncate text-[10px] font-bold uppercase tracking-widest text-primary">Conversation</h2>
          {locked && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-200">
              <Lock className="h-2.5 w-2.5" aria-hidden /> Context kept
            </span>
          )}
        </div>
        {!empty && (
          <button
            type="button"
            onClick={onNewAnalysis}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/25 px-3 py-1.5 text-[11px] font-bold text-primary hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <Plus className="h-3 w-3" aria-hidden /> New analysis
          </button>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={listRef} onScroll={onScroll} role="log" aria-label="Messages" className="h-full space-y-5 overflow-y-auto px-4 py-4">
          {empty ? (
            <div className="mx-auto flex max-w-xl flex-col items-center py-6 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Sparkles className="h-6 w-6" aria-hidden />
              </div>
              <h3 className="text-base font-bold text-on-surface">Ask about your decoys and logs</h3>
              <p className="mt-1 text-xs leading-5 text-on-surface-variant">
                Pick servers and a time range on the left, then ask in plain language. You get a summary, timeline, affected assets, risk assessment and recommended actions, with record IDs and timestamps you can verify.
              </p>
              <div className="mt-5 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                {PROMPT_CHIPS.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    onClick={() => sendChip(c.prompt, true)}
                    className="rounded-xl border border-outline-variant/25 bg-surface-container-lowest px-3.5 py-3 text-left text-xs font-semibold text-on-surface transition-colors hover:border-primary/40 hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    {c.label}
                    <span className="mt-0.5 block text-[10.5px] font-normal leading-4 text-on-surface-variant">{c.prompt}</span>
                  </button>
                ))}
              </div>
              <ul className="mt-6 space-y-1.5 text-left text-[11px] text-on-surface-variant">
                <li className="flex gap-2"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden /> Read-only. Secrets (keys, passwords, tokens, env values) are redacted before anything is sent to the AI.</li>
                <li className="flex gap-2"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden /> Answers use only your data. If it is not enough, the AI says so, and each query is audit-logged.</li>
              </ul>
            </div>
          ) : (
            messages.map((m, i) => <MessageBubble key={m.id} message={m} isLast={i === messages.length - 1} onRetry={onRetry} />)
          )}
          {notice && (
            <p className="flex gap-2 rounded-xl bg-amber-50 p-3 text-[11.5px] leading-5 text-amber-900 ring-1 ring-amber-200" role="status">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {notice}
            </p>
          )}
        </div>
        {showJump && (
          <button
            type="button"
            onClick={() => {
              stick.current = true;
              setShowJump(false);
              scrollToEnd(true);
            }}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[11px] font-bold text-white shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <ArrowDown className="h-3 w-3" aria-hidden /> Jump to latest
          </button>
        )}
      </div>

      <div className="border-t border-outline-variant/10 bg-surface-container-low/40 px-4 pb-3 pt-3">
        {!empty && !busy && (
          <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1" aria-label="Suggested prompts">
            {PROMPT_CHIPS.map((c) => (
              <button
                key={c.label}
                type="button"
                onClick={() => sendChip(c.prompt, false)}
                className="shrink-0 rounded-full border border-outline-variant/30 bg-white px-3 py-1 text-[11px] font-semibold text-on-surface-variant transition-colors hover:border-primary/40 hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        <div className={`flex items-end gap-2 rounded-2xl border bg-white p-2 transition-colors focus-within:ring-2 focus-within:ring-primary/30 ${over ? "border-error/60" : "border-outline-variant/40"}`}>
          <textarea
            ref={taRef}
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={placeholder}
            aria-label="Your question"
            aria-invalid={over || undefined}
            className="max-h-[150px] min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] leading-5 text-on-surface outline-none placeholder:text-on-surface-variant/60"
          />
          {busy ? (
            <button type="button" onClick={onStop} aria-label="Stop generating" className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-on-surface px-4 text-xs font-bold text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
              <Square className="h-3 w-3 fill-current" aria-hidden /> Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || over}
              aria-label="Send question"
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-bold text-white shadow-lg shadow-primary/20 transition-colors hover:bg-primary-container focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              <Send className="h-3.5 w-3.5" aria-hidden /> Send
            </button>
          )}
        </div>
        <div className="mt-1.5 flex justify-between px-1 text-[10px] text-on-surface-variant">
          <span>Enter to send · Shift+Enter for a new line</span>
          <span className={over ? "font-bold text-error" : ""} aria-live="polite">
            {draft.length}/{MAX_MESSAGE_CHARS}
          </span>
        </div>
      </div>
    </section>
  );
}
