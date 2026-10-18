"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { usePathname } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import {
  X,
  ChevronRight,
  ChevronLeft,
  Sparkles,
  RotateCcw,
  Play,
  Compass,
} from "lucide-react";
import { SentinelAvatar } from "@/components/SentinelAvatar";
import type { SentinelAnimation, SentinelExpression } from "@/lib/sentinelAvatar";

// ─── Tour Step Definitions ───────────────────────────────────────────────────

interface TourStep {
  /** CSS selector for the target element to spotlight */
  target: string;
  /** Title shown in the speech bubble */
  title: string;
  /** Category badge */
  badge: string;
  /** Description text */
  description: string;
  /** Emoji icon for the step */
  icon: string;
  /** Avatar procedural animation for this step */
  animation?: SentinelAnimation;
  /** Avatar procedural expression for this step */
  expression?: SentinelExpression;
  /** Relative positioning for mascot & speech bubble */
  placement: "sidebar-item" | "topnav-item" | "header" | "card-top-right" | "card-top-left" | "button";
  /** Whether to scroll the target into view */
  scrollIntoView?: boolean;
}

const TOUR_STEPS: TourStep[] = [
  // 1. Welcome Header
  {
    target: "[data-tour='welcome']",
    title: "Mission Control Overview",
    badge: "SOC Command Center",
    description:
      "Welcome Operator! I'm Aegis Helper. I'll guide you through the dashboard and show you where to find each security tool.",
    icon: "🛡️",
    animation: "guide",
    expression: "happy",
    placement: "header",
    scrollIntoView: false,
  },

  // 2. Topnav Health
  {
    target: "[data-tour='topnav-status']",
    title: "API Gateway Status",
    badge: "Gateway Telemetry",
    description:
      "This live pulse indicator monitors our central SOC API gateway. Green signals active cryptographic telemetry streaming, low latency, and healthy backend clustering.",
    icon: "🧭",
    expression: "explaining",
    placement: "topnav-item",
    scrollIntoView: false,
  },

  // 3. Navigation: Dashboard
  {
    target: "[data-tour='nav-dashboard']",
    title: "Global SOC Dashboard",
    badge: "Main Flight Deck",
    description:
      "Your home base! Displays global cluster health, real-time threat detection matrices, managed fleet tables, and live telemetry feeds at a glance.",
    icon: "📊",
    expression: "happy",
    placement: "sidebar-item",
    scrollIntoView: false,
  },

  // 4. Navigation: Events Stream
  {
    target: "[data-tour='nav-events']",
    title: "Live Security Events",
    badge: "Reactive SSE Stream",
    description:
      "Drill down into every ingested security event. Filter by severity (Critical, Warning, Info), examine raw payloads, source IP addresses, and forensic hashes.",
    icon: "📡",
    animation: "scanning",
    expression: "thinking",
    placement: "sidebar-item",
    scrollIntoView: false,
  },

  // 5. Navigation: Fleet Infrastructure
  {
    target: "[data-tour='nav-infrastructure']",
    title: "Managed Infrastructure",
    badge: "Cluster Edge Fleet",
    description:
      "Audit every server node in your hybrid cloud. Track memory usage, CPU load, open sockets, threat counts, and uptime with live sync controls.",
    icon: "🖥️",
    expression: "secure",
    placement: "sidebar-item",
    scrollIntoView: false,
  },

  // 7. Navigation: Endpoint Agents
  {
    target: "[data-tour='nav-agents']",
    title: "Sentinel Endpoint Agents",
    badge: "Agent Fleet Control",
    description:
      "Manage all distributed Sentinel daemons running on edge hosts. Check agent versions, push configuration manifests, and verify cryptographic certificates.",
    icon: "🤖",
    expression: "explaining",
    placement: "sidebar-item",
    scrollIntoView: false,
  },

  // 8. Navigation: Settings & Access
  {
    target: "[data-tour='nav-settings']",
    title: "Settings & System Admin",
    badge: "Configuration & Access",
    description:
      "Tune your SOC preferences, manage API keys, audit user role permissions (RBAC), and restart this interactive onboarding tour anytime.",
    icon: "⚙️",
    expression: "explaining",
    placement: "sidebar-item",
    scrollIntoView: false,
  },

  // 10. Dashboard KPIs
  {
    target: "[data-tour='summary-kpis']",
    title: "Operational Defense KPIs",
    badge: "Real-Time Telemetry",
    description:
      "High-level telemetry summaries: Critical Alerts needing triage, Mitigated Incidents neutralized today, Active SOC Analysts online, and overall Network Uptime.",
    icon: "📈",
    animation: "scanning",
    expression: "thinking",
    placement: "card-top-right",
    scrollIntoView: true,
  },

  // 11. Managed Infrastructure Table
  {
    target: "[data-tour='infrastructure']",
    title: "Fleet Node Status Grid",
    badge: "Fleet Monitor",
    description:
      "Detailed view of monitored nodes. Check IP assignments, AWS/GCP/On-Prem locations, active CPU load, RAM utilization, and click Refresh to pull live stats.",
    icon: "💻",
    expression: "secure",
    placement: "card-top-right",
    scrollIntoView: true,
  },

  // 12. Threat Detection Heatmap
  {
    target: "[data-tour='heatmap']",
    title: "Threat Intensity Heatmap",
    badge: "Attack Density",
    description:
      "Temporal attack density visualization across your infrastructure. Darker, glowing cells highlight elevated threat levels so you can spot breach patterns immediately.",
    icon: "🚨",
    animation: "warning",
    expression: "alert",
    placement: "card-top-right",
    scrollIntoView: true,
  },

  // 13. Live Event Stream
  {
    target: "[data-tour='events']",
    title: "Live SSE Event Feed",
    badge: "Instant Telemetry",
    description:
      "Streaming event timeline delivering live telemetry from your endpoint daemons. Each event shows exact timestamp, severity level, source IP, and threat tag.",
    icon: "⚡",
    animation: "scanning",
    expression: "thinking",
    placement: "card-top-left",
    scrollIntoView: true,
  },

  // 14. Forensics Vault
  {
    target: "[data-tour='forensics']",
    title: "Forensics Vault & Decoys",
    badge: "Deception & Honeypots",
    description:
      "Canary decoy assets planted across your environment. If an attacker touches or modifies any decoy file, it triggers an instant alarm and records the intruder's fingerprint.",
    icon: "🔐",
    expression: "explaining",
    placement: "card-top-left",
    scrollIntoView: true,
  },

  // 15. Add New Server Action
  {
    target: "[data-tour='add-server']",
    title: "Onboard New Server",
    badge: "Rapid Deployment",
    description:
      "Ready to add a server to Sentinel? Click this button anytime to open the setup wizard. You'll get a unique join token and a one-line curl command to install the agent!",
    icon: "➕",
    animation: "guide",
    expression: "happy",
    placement: "button",
    scrollIntoView: false,
  },
];

const STORAGE_KEY = "sentinel_tour_completed";
const STORAGE_DISMISSED_KEY = "sentinel_tour_dismissed";

// ─── Main Component ──────────────────────────────────────────────────────────

export function SentinelGuide() {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login" || (pathname != null && pathname.startsWith("/login"));
  const [isActive, setIsActive] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [showAvatar, setShowAvatar] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [idleExpression, setIdleExpression] = useState<SentinelExpression>("neutral");

  // Positioning
  const [mascotPos, setMascotPos] = useState({ top: 120, left: 120 });
  const [bubblePos, setBubblePos] = useState({ top: 220, left: 120 });
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [bubbleVisible, setBubbleVisible] = useState(false);

  const tooltipTimerRef = useRef<NodeJS.Timeout | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // ── Auto-start on first visit ──
  useEffect(() => {
    if (isLoginPage || !isAuthenticated()) {
      setShowAvatar(false);
      setIsActive(false);
      setShowTooltip(false);
      return;
    }

    setShowAvatar(true);
    const completed = localStorage.getItem(STORAGE_KEY);
    const dismissed = localStorage.getItem(STORAGE_DISMISSED_KEY);

    if (!completed && !dismissed) {
      const timer = setTimeout(() => startTour(), 1800);
      return () => clearTimeout(timer);
    } else {
      tooltipTimerRef.current = setTimeout(() => {
        setShowTooltip(true);
        setTimeout(() => setShowTooltip(false), 7000);
      }, 2500);
      return () => {
        if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
      };
    }
  }, [isLoginPage, pathname]);

  // ── Reposition mascot & bubble precisely for step ──
  const updatePositionForCurrentStep = useCallback((stepIdx: number) => {
    const step = TOUR_STEPS[stepIdx];
    if (!step) return;

    const target = document.querySelector(step.target);
    if (!target) {
      // Fallback: smart default near sidebar top
      const defaultMascot = { top: 100, left: 280 };
      const defaultBubble = { top: 200, left: 280 };
      setMascotPos(defaultMascot);
      setBubblePos(defaultBubble);
      setTargetRect(null);
      setBubbleVisible(true);
      return;
    }

    const rect = target.getBoundingClientRect();
    setTargetRect(rect);

    const MASCOT_SIZE = 60;
    const BUBBLE_WIDTH = 320;
    // Step text varies in length, so use the bubble's real height when available
    const BUBBLE_HEIGHT = bubbleRef.current?.offsetHeight || 240;

    let mTop = 0;
    let mLeft = 0;
    let bTop = 0;
    let bLeft = 0;

    switch (step.placement) {
      case "sidebar-item": {
        // Mascot sits right next to the sidebar link
        mTop = rect.top + rect.height / 2 - MASCOT_SIZE / 2;
        mLeft = rect.right + 16;

        // Speech bubble sits to the right of the mascot
        bTop = rect.top - 20;
        bLeft = mLeft + MASCOT_SIZE + 16;
        break;
      }

      case "topnav-item": {
        // Mascot sits below the topnav item
        mTop = rect.bottom + 16;
        mLeft = rect.left;

        // Bubble sits right beside or below
        bTop = mTop + MASCOT_SIZE + 12;
        bLeft = rect.left;
        break;
      }

      case "header": {
        // Mascot sits beside the title
        mTop = rect.top;
        mLeft = Math.min(rect.right - 220, window.innerWidth - MASCOT_SIZE - 20);

        bTop = rect.bottom + 12;
        bLeft = Math.max(20, rect.left);
        break;
      }

      case "card-top-right": {
        // Mascot sits over top-right of wide card
        mTop = rect.top - 36;
        mLeft = Math.min(rect.right - 90, window.innerWidth - MASCOT_SIZE - 24);

        bTop = Math.max(20, rect.top + 50);
        bLeft = Math.min(rect.right - BUBBLE_WIDTH - 20, window.innerWidth - BUBBLE_WIDTH - 24);
        break;
      }

      case "card-top-left": {
        // Mascot sits at top-left / beside the card
        mTop = rect.top - 20;
        mLeft = Math.max(16, rect.left - MASCOT_SIZE - 16);

        // Bubble sits above or to left
        bTop = Math.max(20, rect.top);
        bLeft = Math.max(16, rect.left - BUBBLE_WIDTH - MASCOT_SIZE - 24);
        if (bLeft < 20) {
          bLeft = Math.max(20, rect.left - BUBBLE_WIDTH + 50);
          bTop = rect.top + 60;
        }
        break;
      }

      case "button": {
        // Mascot points directly at the button from bottom-left
        mTop = rect.bottom + 14;
        mLeft = rect.left - 40;

        bTop = mTop + MASCOT_SIZE + 10;
        bLeft = Math.min(rect.left - 180, window.innerWidth - BUBBLE_WIDTH - 24);
        break;
      }

      default: {
        mTop = rect.bottom + 12;
        mLeft = rect.left;
        bTop = mTop + MASCOT_SIZE + 12;
        bLeft = rect.left;
      }
    }

    // Clamp coordinates safely within viewport
    mTop = Math.max(16, Math.min(window.innerHeight - MASCOT_SIZE - 16, mTop));
    mLeft = Math.max(16, Math.min(window.innerWidth - MASCOT_SIZE - 16, mLeft));

    bTop = Math.max(16, Math.min(window.innerHeight - BUBBLE_HEIGHT - 16, bTop));
    bLeft = Math.max(16, Math.min(window.innerWidth - BUBBLE_WIDTH - 16, bLeft));

    setMascotPos({ top: mTop, left: mLeft });
    setBubblePos({ top: bTop, left: bLeft });
  }, []);

  // ── Navigate smoothly to a step ──
  const navigateToStep = useCallback((stepIdx: number) => {
    const step = TOUR_STEPS[stepIdx];
    if (!step) return;

    setBubbleVisible(false);
    setIsTransitioning(true);

    const target = document.querySelector(step.target);
    if (target && step.scrollIntoView) {
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }

    // Give scroll time to settle, then update coordinates
    const delay = step.scrollIntoView ? 380 : 60;
    setTimeout(() => {
      updatePositionForCurrentStep(stepIdx);
      setIsTransitioning(false);
      setBubbleVisible(true);
    }, delay);
  }, [updatePositionForCurrentStep]);

  // ── Listen for step change and resize / scroll events ──
  useEffect(() => {
    if (!isActive) return;

    navigateToStep(currentStep);

    const handleResize = () => updatePositionForCurrentStep(currentStep);
    const mainEl = document.querySelector("main");

    window.addEventListener("resize", handleResize);
    mainEl?.addEventListener("scroll", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      mainEl?.removeEventListener("scroll", handleResize);
    };
  }, [currentStep, isActive, navigateToStep, updatePositionForCurrentStep]);

  // ── Controls ──
  const startTour = () => {
    setIsActive(true);
    setCurrentStep(0);
    setShowTooltip(false);
  };

  const closeTour = () => {
    setIsActive(false);
    localStorage.setItem(STORAGE_DISMISSED_KEY, "true");
  };

  const finishTour = () => {
    setIsActive(false);
    localStorage.setItem(STORAGE_KEY, "true");
  };

  const nextStep = useCallback(() => {
    if (currentStep < TOUR_STEPS.length - 1) {
      setCurrentStep((s) => s + 1);
    } else {
      finishTour();
    }
  }, [currentStep]);

  const prevStep = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep((s) => s - 1);
    }
  }, [currentStep]);

  const step = TOUR_STEPS[currentStep];
  const progress = ((currentStep + 1) / TOUR_STEPS.length) * 100;

  if (isLoginPage || !showAvatar || !isAuthenticated()) return null;

  return (
    <>
      {/* ═══════════════════════════════════════════════════════════════════
          IDLE STATE: Procedural living avatar in dock with interactive bubble
      ═══════════════════════════════════════════════════════════════════ */}
      {!isActive && (
        <aside aria-label="Aegis Helper" className="fixed bottom-6 right-6 z-[100] flex flex-col items-end gap-3 pointer-events-auto">
          {/* Quick Tip / Prompt */}
          {showTooltip && (
            <div
              className="bg-slate-950/95 backdrop-blur-2xl rounded-2xl shadow-[0_16px_48px_rgba(0,0,0,0.6)] border border-cyan-500/30 px-4 py-3 max-w-[270px] relative transition-all duration-300"
              style={{ animation: "guideSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)" }}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-400">
                  <Compass className="w-3.5 h-3.5" />
                </span>
                <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-widest">
                  Aegis Helper
                </span>
              </div>
              <p className="text-xs text-slate-200 font-medium leading-relaxed">
                Click me for a full guided tour! I&apos;ll walk you through every navigation link and security tool.
              </p>
              <div className="mt-2.5 pt-2 border-t border-slate-800 flex items-center justify-between">
                <button
                  onClick={startTour}
                  className="inline-flex items-center gap-1.5 text-[11px] font-bold text-cyan-400 hover:text-cyan-300 transition-colors"
                >
                  <Play className="w-3 h-3 fill-current" />
                  Start Guided Tour
                </button>
                <button
                  onClick={() => setShowTooltip(false)}
                  className="text-[10px] text-slate-400 hover:text-slate-200"
                >
                  Dismiss
                </button>
              </div>
              <div className="absolute bottom-[-6px] right-8 w-3 h-3 rotate-45 bg-slate-950 border-r border-b border-cyan-500/30" />
            </div>
          )}

          {/* Living Avatar Button */}
          <button
            onClick={startTour}
            onMouseEnter={() => {
              setIdleExpression("happy");
              setShowTooltip(true);
            }}
            onMouseLeave={() => setIdleExpression("neutral")}
            className="relative rounded-full transition-transform duration-300 hover:scale-110 active:scale-95 drop-shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
            title="Aegis Helper — Click to start guided tour"
          >
            <SentinelAvatar
              size={54}
              animation={idleExpression === "neutral" ? "idle" : undefined}
              expression={idleExpression !== "neutral" ? idleExpression : undefined}
            />
          </button>
        </aside>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          ACTIVE TOUR: Spotlight + Moving Live Procedural Mascot + Speech Bubble
      ═══════════════════════════════════════════════════════════════════ */}
      {isActive && (
        <>
          {/* ── Spotlight Overlay ───────────────────────────────────────── */}
          <div className="fixed inset-0 z-[200] pointer-events-none">
            <svg className="absolute inset-0 w-full h-full">
              <defs>
                <mask id="spotlight-mask">
                  <rect width="100%" height="100%" fill="white" />
                  {targetRect && (
                    <rect
                      x={targetRect.left - 8}
                      y={targetRect.top - 8}
                      width={targetRect.width + 16}
                      height={targetRect.height + 16}
                      rx="14"
                      fill="black"
                      className="transition-all duration-500 ease-out"
                    />
                  )}
                </mask>
              </defs>
              <rect
                width="100%"
                height="100%"
                fill="rgba(2, 6, 23, 0.72)"
                mask="url(#spotlight-mask)"
                className="transition-all duration-500"
              />
            </svg>

            {/* Glowing target framing border */}
            {targetRect && (
              <div
                className="absolute border-2 border-cyan-400 rounded-2xl transition-all duration-500 ease-out shadow-[0_0_35px_rgba(34,211,238,0.5)]"
                style={{
                  top: targetRect.top - 8,
                  left: targetRect.left - 8,
                  width: targetRect.width + 16,
                  height: targetRect.height + 16,
                }}
              >
                <div className="absolute -top-1.5 -left-1.5 w-3.5 h-3.5 border-t-2 border-l-2 border-cyan-300 rounded-tl-lg" />
                <div className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 border-t-2 border-r-2 border-cyan-300 rounded-tr-lg" />
                <div className="absolute -bottom-1.5 -left-1.5 w-3.5 h-3.5 border-b-2 border-l-2 border-cyan-300 rounded-bl-lg" />
                <div className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 border-b-2 border-r-2 border-cyan-300 rounded-br-lg" />
              </div>
            )}
          </div>

          {/* ── Top-right Exit tour button ──────────────────────────────── */}
          <button
            onClick={closeTour}
            className="fixed top-20 right-6 z-[210] p-2.5 rounded-full bg-slate-950/90 backdrop-blur-xl border border-cyan-500/30 shadow-2xl hover:bg-slate-900 transition-all text-slate-300 hover:text-rose-400 hover:scale-105 active:scale-95"
            title="Exit Tour"
          >
            <X className="w-4 h-4" />
          </button>

          {/* ── Moving Procedural Mascot ─────────────────────────────────── */}
          <div
            className="fixed z-[220] pointer-events-none"
            style={{
              top: mascotPos.top,
              left: mascotPos.left,
              transition: "all 0.65s cubic-bezier(0.34, 1.56, 0.64, 1)",
            }}
          >
            <div className={`relative ${isTransitioning ? "scale-90" : "scale-100"} transition-transform duration-300 drop-shadow-[0_8px_24px_rgba(0,0,0,0.6)]`}>
              <SentinelAvatar
                size={58}
                animation={step.animation}
                expression={step.animation ? undefined : step.expression}
              />
            </div>
          </div>

          {/* ── Dynamic Speech Bubble ──────────────────────────────────── */}
          <div
            ref={bubbleRef}
            className={`fixed z-[215] transition-all duration-400 ease-out pointer-events-auto ${
              bubbleVisible
                ? "opacity-100 scale-100"
                : "opacity-0 scale-95 pointer-events-none"
            }`}
            style={{
              top: bubblePos.top,
              left: bubblePos.left,
              width: 320,
            }}
          >
            <div className="bg-slate-950/95 backdrop-blur-2xl rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.7)] border border-cyan-500/35 overflow-hidden">
              {/* Header */}
              <div className="bg-gradient-to-r from-primary/30 via-cyan-950/60 to-primary/20 border-b border-cyan-500/20 px-5 py-3.5 flex items-center gap-3">
                <span className="text-2xl drop-shadow">{step.icon}</span>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-bold text-white truncate">
                    {step.title}
                  </h3>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Sparkles className="w-2.5 h-2.5 text-cyan-400" />
                    <span className="text-[9px] font-bold text-cyan-300 uppercase tracking-widest">
                      {step.badge} • Step {currentStep + 1} of {TOUR_STEPS.length}
                    </span>
                  </div>
                </div>
              </div>

              {/* Body */}
              <div className="px-5 py-3.5">
                <p className="text-[13px] text-slate-200 leading-relaxed font-normal">
                  {step.description}
                </p>
              </div>

              {/* Progress bar */}
              <div className="h-1 bg-slate-800 mx-5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-400 to-blue-500 transition-all duration-500 ease-out rounded-full"
                  style={{ width: `${progress}%` }}
                />
              </div>

              {/* Footer Controls */}
              <div className="px-5 pt-3 pb-3.5 space-y-3">
                {/* Step pill dots */}
                <div className="flex flex-wrap justify-center gap-1">
                  {TOUR_STEPS.map((_, idx) => (
                    <button
                      key={idx}
                      onClick={() => setCurrentStep(idx)}
                      className={`h-1.5 rounded-full transition-all duration-300 ${
                        idx === currentStep
                          ? "w-4 bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]"
                          : idx < currentStep
                          ? "w-1.5 bg-cyan-700/60"
                          : "w-1.5 bg-slate-800"
                      }`}
                      title={`Step ${idx + 1}`}
                    />
                  ))}
                </div>

                {/* Nav buttons */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={prevStep}
                    disabled={currentStep === 0}
                    className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-all disabled:invisible"
                    title="Previous"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    Back
                  </button>
                  <div className="flex-1" />
                  {currentStep < TOUR_STEPS.length - 1 && (
                    <button
                      onClick={closeTour}
                      className="px-2.5 py-1 text-[11px] font-medium text-slate-400 hover:text-white rounded-lg transition-colors"
                    >
                      Skip
                    </button>
                  )}
                  <button
                    onClick={nextStep}
                    className="shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold text-white bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 rounded-lg transition-all shadow-md shadow-cyan-500/25 active:scale-95"
                  >
                    {currentStep === TOUR_STEPS.length - 1 ? (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        Finish!
                      </>
                    ) : (
                      <>
                        Next
                        <ChevronRight className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ─── Settings Restart Tour Button ─────────────────────────────────────────────

export function RestartTourButton() {
  const handleRestart = () => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_DISMISSED_KEY);
    window.location.reload();
  };

  return (
    <button
      onClick={handleRestart}
      className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-primary bg-primary/10 border border-primary/20 rounded-xl hover:bg-primary/20 transition-all active:scale-95"
    >
      <RotateCcw className="w-4 h-4" />
      Restart Guided Tour
    </button>
  );
}
