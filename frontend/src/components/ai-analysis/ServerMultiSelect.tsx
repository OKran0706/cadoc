"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, RefreshCw, Search, Server, X } from "lucide-react";
import type { ServerResponse } from "@/lib/types";

interface Props {
  servers: ServerResponse[];
  selected: string[];
  onChange: (ids: string[]) => void;
  max: number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  disabled?: boolean;
  hasError?: boolean;
}

export function ServerMultiSelect({ servers, selected, onChange, max, loading, error, onRetry, disabled, hasError }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const byId = useMemo(() => new Map(servers.map((s) => [s.id, s])), [servers]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? servers.filter((s) => s.hostname.toLowerCase().includes(q) || (s.ip_address ?? "").includes(q)) : servers;
  }, [servers, query]);
  const atMax = selected.length >= max;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      document.removeEventListener("mousedown", onDown);
      clearTimeout(t);
    };
  }, [open]);

  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else if (!atMax) onChange([...selected, id]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(filtered.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[active]) toggle(filtered[active].id);
    } else if (e.key === "Backspace" && !query && selected.length) {
      onChange(selected.slice(0, -1));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-outline-variant/30 bg-surface-container-lowest px-3 py-2.5 text-xs text-on-surface-variant" role="status">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> Loading servers…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-error/20 bg-error/5 p-3 text-xs text-error" role="alert">
        <p>Could not load servers: {error}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="mt-2 inline-flex items-center gap-1 font-bold underline-offset-2 hover:underline">
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        )}
      </div>
    );
  }
  if (servers.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-lowest p-3 text-center text-xs text-on-surface-variant">
        No servers are registered yet. Add one under Infrastructure to analyse it here.
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setActive(0);
          setQuery("");
          setOpen((o) => !o);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        className={`flex min-h-[2.6rem] w-full items-center gap-2 rounded-xl border bg-surface-container-lowest px-3 py-2 text-left text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60 ${
          hasError ? "border-error/60" : "border-outline-variant/40 hover:border-primary/40"
        }`}
      >
        <Server className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="flex min-w-0 flex-1 flex-wrap gap-1">
          {selected.length === 0 ? (
            <span className="text-on-surface-variant/70">Select one or more servers…</span>
          ) : (
            selected.map((id) => (
              <span key={id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                {byId.get(id)?.hostname ?? id}
                {!disabled && (
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Remove ${byId.get(id)?.hostname ?? id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        toggle(id);
                      }
                    }}
                    className="rounded-full hover:bg-primary/20 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  >
                    <X className="h-3 w-3" />
                  </span>
                )}
              </span>
            ))
          )}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-on-surface-variant transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute z-30 mt-1.5 w-full overflow-hidden rounded-xl border border-outline-variant/30 bg-white shadow-xl">
          <div className="flex items-center gap-2 border-b border-outline-variant/20 px-3 py-2">
            <Search className="h-3.5 w-3.5 text-on-surface-variant" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search by hostname or IP"
              aria-label="Search servers"
              aria-controls={listId}
              className="w-full bg-transparent text-xs outline-none placeholder:text-on-surface-variant/60"
            />
          </div>
          <ul id={listId} role="listbox" aria-multiselectable="true" aria-label="Servers" className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 && <li className="px-3 py-3 text-center text-xs text-on-surface-variant">No servers match “{query}”.</li>}
            {filtered.map((s, i) => {
              const isSel = selected.includes(s.id);
              const blocked = !isSel && atMax;
              return (
                <li
                  key={s.id}
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={blocked || undefined}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => toggle(s.id)}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-xs ${i === active ? "bg-surface-container-low" : ""} ${blocked ? "cursor-not-allowed opacity-45" : ""}`}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${isSel ? "border-primary bg-primary text-white" : "border-outline-variant"}`}>
                    {isSel && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-on-surface">{s.hostname}</span>
                    <span className="block truncate font-mono text-[10px] text-on-surface-variant">{s.ip_address}</span>
                  </span>
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.status === "active" ? "bg-emerald-500" : "bg-outline"}`} title={s.status} />
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between border-t border-outline-variant/20 bg-surface-container-low px-3 py-1.5 text-[10px] text-on-surface-variant">
            <span>
              {selected.length} / {max} selected{atMax ? " (limit reached)" : ""}
            </span>
            {selected.length > 0 && (
              <button type="button" onClick={() => onChange([])} className="font-bold text-primary hover:underline">
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
