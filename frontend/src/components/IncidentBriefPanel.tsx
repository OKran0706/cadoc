"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Copy, Printer, ArrowUpRight, Sparkles, RefreshCw, KeyRound, Check } from "lucide-react";
import { incidentBriefSchema, formatBriefAsMarkdown, type IncidentBrief } from "@/lib/incidentBrief";
import { formatIncidentTime } from "@/lib/incidentExplainer";
import type { TopologyNode } from "@/lib/holisticData";
import "./IncidentBriefPanel.css";

interface Props {
  brief: IncidentBrief | null;
  selectedNode: TopologyNode | null;
  allNodes?: TopologyNode[];
  isOpen: boolean;
  onClose: () => void;
  onSelectNeighbourNode: (id: string) => void;
  onIsolateNode: (node: TopologyNode) => void;
  canRespond?: boolean;
}

export function IncidentBriefPanel({
  brief: inputFallback,
  selectedNode,
  allNodes = [],
  isOpen,
  onClose,
  onSelectNeighbourNode,
  onIsolateNode,
  canRespond = false,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [checklists, setChecklists] = useState<Record<string, Record<string, boolean>>>({});
  const [copyStatus, setCopyStatus] = useState<{ id: string; message: string } | null>(null);

  // Gemini Live AI State
  const [liveBrief, setLiveBrief] = useState<IncidentBrief | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [engineSource, setEngineSource] = useState<"llm" | "rules">("llm");
  const [modelName, setModelName] = useState<string>("gemini-2.5-flash");
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keySavedNotice, setKeySavedNotice] = useState(false);

  // Load saved API key on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("sentinel_gemini_api_key") || "";
      setApiKeyInput(saved);
    }
  }, []);

  // Compute validated fallback brief
  const fallbackBrief = useMemo(() => {
    const result = incidentBriefSchema.safeParse(inputFallback);
    return result.success && result.data.nodeId === selectedNode?.id ? result.data : null;
  }, [inputFallback, selectedNode?.id]);

  // While generating with Gemini, brief is strictly null so hardcoded details are NEVER shown initially
  const brief = liveBrief || (isGenerating ? null : fallbackBrief);
  const checked = brief ? checklists[brief.id] ?? {} : {};

  // Fetch AI incident brief from Gemini API route
  const fetchGeminiBrief = useCallback(async (nodeToExplain: TopologyNode) => {
    if (!nodeToExplain.incident) return;
    setIsGenerating(true);
    setShowSkeleton(true);

    try {
      const storedKey = typeof window !== "undefined" ? localStorage.getItem("sentinel_gemini_api_key") || "" : "";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (storedKey) {
        headers["x-gemini-api-key"] = storedKey;
      }

      const res = await fetch("/api/incident-brief", {
        method: "POST",
        headers,
        body: JSON.stringify({
          node: nodeToExplain,
          incident: nodeToExplain.incident,
          context: { allNodes },
          apiKey: storedKey || undefined,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.brief) {
          const validated = incidentBriefSchema.safeParse(data.brief);
          if (validated.success) {
            setLiveBrief(validated.data);
            setEngineSource(data.engine || "llm");
            if (data.model) setModelName(data.model);
          }
        }
      }
    } catch (err) {
      console.warn("Gemini incident brief request notice:", err);
    } finally {
      setIsGenerating(false);
      setShowSkeleton(false);
    }
  }, [allNodes]);

  // Trigger Gemini analysis when panel opens or when selected node changes
  useEffect(() => {
    if (!isOpen || !selectedNode) {
      setLiveBrief(null);
      setShowSkeleton(false);
      setIsGenerating(false);
      return;
    }

    // Always start with AI generation state - never show hardcoded details initially
    setLiveBrief(null);
    setShowSkeleton(true);
    setIsGenerating(true);

    if (selectedNode.incident) {
      fetchGeminiBrief(selectedNode);
    } else {
      setShowSkeleton(false);
      setIsGenerating(false);
    }
  }, [isOpen, selectedNode?.id, fetchGeminiBrief]);

  // Dialog accessibility focus management
  useEffect(() => {
    if (!isOpen || !dialogRef.current) return;
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('[aria-label="Close incident brief"]')?.focus();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const copy = async () => {
    if (!brief) return;
    try {
      await navigator.clipboard.writeText(formatBriefAsMarkdown(brief, checked));
      setCopyStatus({ id: brief.id, message: "Copied as Markdown" });
    } catch {
      setCopyStatus({
        id: brief.id,
        message: "Clipboard unavailable. Allow clipboard access and retry, or use Print / PDF.",
      });
    }
  };

  const handleSaveApiKey = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem("sentinel_gemini_api_key", apiKeyInput.trim());
      setKeySavedNotice(true);
      setTimeout(() => setKeySavedNotice(false), 2500);
      setShowApiKeyModal(false);
      if (selectedNode) {
        fetchGeminiBrief(selectedNode);
      }
    }
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="incident-brief-dialog"
      aria-labelledby="brief-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <article className="brief-panel">
        <header className="brief-header">
          <div>
            <div className="brief-eyebrow">FORENSICS / INCIDENT ANALYSIS</div>
            <div className="brief-title-row">
              <h2 id="brief-title">AI Incident Brief</h2>
              {isGenerating ? (
                <span className="brief-engine brief-engine-gemini animate-pulse">
                  <Sparkles size={12} className="animate-spin text-violet-400" />
                  Generating with {modelName}...
                </span>
              ) : engineSource === "llm" ? (
                <span className="brief-engine brief-engine-gemini" title={`Analyzed live by ${modelName}`}>
                  <Sparkles size={12} className="text-violet-400" />
                  {modelName} (Live AI)
                </span>
              ) : (
                <span className="brief-engine" title="SOC Rules Engine Fallback">
                  ⚡ Rules engine
                </span>
              )}
            </div>
            <p>
              {selectedNode?.name ?? "No node selected"}
              {selectedNode?.ip ? " · " + selectedNode.ip : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => selectedNode && fetchGeminiBrief(selectedNode)}
              disabled={isGenerating || !selectedNode?.incident}
              className="p-1.5 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition-colors"
              title="Re-analyze incident with Gemini AI"
              aria-label="Re-analyze incident with Gemini AI"
            >
              <RefreshCw size={15} className={isGenerating ? "animate-spin text-cyan-400" : ""} />
            </button>
            <button
              onClick={() => setShowApiKeyModal(!showApiKeyModal)}
              className="p-1.5 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition-colors"
              title="Configure Gemini API Key"
              aria-label="Configure Gemini API Key"
            >
              <KeyRound size={15} />
            </button>
            <button onClick={onClose} aria-label="Close incident brief">
              <X size={18} />
            </button>
          </div>
        </header>

        {/* API Key Configuration Dropdown */}
        {showApiKeyModal && (
          <div className="brief-key-box px-6 py-3 bg-[#111927] border-b border-slate-700/60 flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
              <span className="flex items-center gap-1.5">
                <KeyRound size={13} className="text-violet-400" />
                Google Gemini API Key
              </span>
              <span className="text-[10px] text-slate-400">Stored locally in browser</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="password"
                placeholder="AIzaSy... (leave blank to use backend env key)"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                className="flex-1 bg-[#090d16] border border-slate-700 rounded px-2.5 py-1.5 text-xs text-white font-mono placeholder:text-slate-600 focus:outline-none focus:border-violet-500"
              />
              <button
                onClick={handleSaveApiKey}
                className="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white rounded text-xs font-semibold transition-colors flex items-center gap-1 shadow-md"
              >
                <Check size={13} />
                Save & Run
              </button>
            </div>
            {keySavedNotice && (
              <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                <Check size={12} /> Key updated. Re-generating incident brief with Gemini...
              </span>
            )}
          </div>
        )}

        <div className="brief-toolbar">
          <span>{brief?.isolated ? "Contained · live mesh" : "Analyst review · live telemetry"}</span>
          <div className="flex items-center gap-2">
            <button onClick={copy} disabled={!brief} aria-label="Copy incident brief as Markdown">
              <Copy size={14} /> Copy Markdown
            </button>
            <button
              onClick={() => window.print()}
              disabled={!brief || showSkeleton || isGenerating}
              aria-label="Print or save incident brief as PDF"
            >
              <Printer size={14} /> Print / PDF
            </button>
          </div>
        </div>

        <p className="brief-copy-status" role="status">
          {copyStatus?.id === brief?.id ? copyStatus?.message : ""}
        </p>

        <div className="brief-body">
          {showSkeleton || isGenerating ? (
            <div role="status" aria-label="Consulting Gemini AI Security Intelligence" className="brief-skeleton py-8">
              <div className="flex flex-col gap-2 p-4 rounded-xl bg-violet-950/25 border border-violet-700/40 text-violet-200 shadow-xl">
                <div className="text-sm font-semibold flex items-center gap-2 text-violet-300">
                  <Sparkles size={16} className="animate-spin text-violet-400" />
                  Generating AI Incident Brief with Google {modelName}...
                </div>
                <p className="text-xs text-slate-300 font-mono">
                  Transmitting {selectedNode?.name} telemetry, eBPF signals, and network topology to Gemini for live threat analysis...
                </p>
              </div>
              <div className="space-y-4 mt-4">
                <div className="h-20 bg-slate-800/40 rounded-lg animate-pulse" />
                <div className="h-28 bg-slate-800/40 rounded-lg animate-pulse" />
                <div className="h-28 bg-slate-800/40 rounded-lg animate-pulse" />
              </div>
            </div>
          ) : !brief ? (
            <div className="brief-empty">
              <h3>{selectedNode?.incident ? "Brief unavailable" : "No active incident"}</h3>
              <p>
                {selectedNode?.incident
                  ? "This incident could not be validated. Review its source telemetry."
                  : "This node has no active incident to explain. Close this panel to inspect it in the current view."}
              </p>
            </div>
          ) : (
            <>
              {/* Section 1: Summary */}
              <section aria-labelledby="brief-summary">
                <h3 id="brief-summary">
                  <span>01</span> Summary
                </h3>
                <p className="brief-summary">{brief.summary}</p>
              </section>

              {/* Section 2: Evidence Facts */}
              {!!brief.evidence.length && (
                <section aria-labelledby="brief-evidence">
                  <h3 id="brief-evidence">
                    <span>02</span> Evidence <small>Recorded telemetry facts</small>
                  </h3>
                  <ul className="brief-evidence">
                    {brief.evidence.map((e) => (
                      <li key={e.id}>
                        <p>{e.description}</p>
                        <div>
                          <code>{e.sourceField}</code>
                          <time dateTime={e.timestamp}>{formatIncidentTime(e.timestamp)}</time>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Section 3: MITRE ATT&CK Mapping */}
              <section aria-labelledby="brief-attack">
                <h3 id="brief-attack">
                  <span>03</span> ATT&CK mapping
                </h3>
                {brief.unmappedReason && (
                  <p>
                    <strong>Unmapped</strong> — {brief.unmappedReason}
                  </p>
                )}
                {brief.attackMapping.map((m) => (
                  <div className="brief-mapping" key={m.techniqueId}>
                    <div>
                      <a href={m.url} target="_blank" rel="noopener noreferrer">
                        {m.techniqueId} · {m.techniqueName}
                        <ArrowUpRight size={13} />
                      </a>
                      <span>Confidence: {m.confidence}</span>
                    </div>
                    <p className="brief-muted">
                      {m.tactic} · {m.independentSignals} independent matching sensor
                      {m.independentSignals === 1 ? "" : "s"}
                    </p>
                    <p>Matched because {m.matchedReason}</p>
                  </div>
                ))}
                <p className="brief-note">
                  Confidence: 1 independent matching sensor is Low, 2 Medium, 3 or more High.
                </p>
              </section>

              {/* Section 4: Likely Intent */}
              {brief.likelyIntent && (
                <section aria-labelledby="brief-intent">
                  <h3 id="brief-intent">
                    <span>04</span> Likely intent <small>Analysis (inference)</small>
                  </h3>
                  <div className="brief-inference">{brief.likelyIntent}</div>
                </section>
              )}

              {/* Section 5: Blast Radius */}
              {brief.blastRadius && (
                <section aria-labelledby="brief-blast">
                  <h3 id="brief-blast">
                    <span>05</span> Blast radius
                  </h3>
                  <p className="brief-muted">
                    Shared infrastructure indicates potential exposure, not confirmed compromise.
                  </p>
                  <dl className="brief-boundaries">
                    {[
                      ["Cluster", brief.blastRadius.sharedCluster],
                      ["VPC", brief.blastRadius.sharedVpc],
                      ["Facility", brief.blastRadius.sharedFacility],
                      ["Country", brief.blastRadius.sharedCountry],
                    ].map(
                      ([label, value]) =>
                        value && (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        )
                    )}
                  </dl>
                  <div className="brief-neighbours">
                    {brief.blastRadius.neighbours.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => onSelectNeighbourNode(n.id)}
                        aria-label={"Inspect " + n.name}
                      >
                        <span>
                          <strong>{n.name}</strong>
                          <small>{n.relationships.join(" / ")}</small>
                        </span>
                        <span className={"status-" + n.status}>{n.isolated ? "Isolated" : n.status}</span>
                        <ArrowUpRight size={14} />
                      </button>
                    ))}
                  </div>
                  {!brief.blastRadius.neighbours.length && (
                    <p className="brief-note">
                      No other nodes share the known boundaries in the supplied inventory.
                    </p>
                  )}
                </section>
              )}

              {/* Section 6: Recommended Actions Checklist */}
              <section aria-labelledby="brief-actions">
                <h3 id="brief-actions">
                  <span>06</span> Recommended actions
                </h3>
                <p className="brief-muted">Analyst checklist. Actions are never executed automatically.</p>
                <ol className="brief-actions">
                  {brief.recommendedActions.map((a) => (
                    <li key={a.id}>
                      {a.isAppAction ? (
                        <>
                          <strong>{a.action}</strong>
                          <p>{a.description}</p>
                          <button
                            className="brief-contain"
                            disabled={a.completed || !canRespond}
                            onClick={() => selectedNode && onIsolateNode(selectedNode)}
                            aria-label={a.completed ? "Node isolated" : "Isolate node from brief"}
                          >
                            {a.completed ? "Isolated" : "Isolate node"}
                          </button>
                        </>
                      ) : (
                        <label>
                          <input
                            type="checkbox"
                            checked={Boolean(checked[a.id])}
                            onChange={() =>
                              setChecklists((prev) => ({
                                ...prev,
                                [brief.id]: {
                                  ...prev[brief.id],
                                  [a.id]: !prev[brief.id]?.[a.id],
                                },
                              }))
                            }
                          />
                          <span>
                            <strong>{a.action}</strong>
                            <p>{a.description}</p>
                          </span>
                        </label>
                      )}
                    </li>
                  ))}
                </ol>
                {!canRespond && !brief.isolated && (
                  <p className="brief-note">Containment requires response permission.</p>
                )}
              </section>

              {/* Section 7: Timeline */}
              {!!brief.timeline.length && (
                <section aria-labelledby="brief-timeline">
                  <h3 id="brief-timeline">
                    <span>07</span> Timeline
                  </h3>
                  <ol className="brief-timeline">
                    {brief.timeline.map((e) => (
                      <li key={e.id}>
                        <div>
                          <time dateTime={e.timestamp}>{formatIncidentTime(e.timestamp)}</time>
                          <span>{e.relativeTime}</span>
                        </div>
                        <p>{e.event}</p>
                        <small>{e.source}</small>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              <footer className="brief-footer">
                {engineSource === "llm" ? `Powered by Google ${modelName} · ` : ""}
                {brief.generatedAt
                  ? "Telemetry snapshot: " + formatIncidentTime(brief.generatedAt)
                  : "Partial incident record"}
                <br />
                Prepared from active cluster telemetry. Validate inferences before executing response playbooks.
              </footer>
            </>
          )}
        </div>
      </article>
    </dialog>,
    document.body
  );
}
