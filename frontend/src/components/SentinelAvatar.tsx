"use client";

import { useEffect, useId, useState } from "react";
import { Avatar } from "@bible-strong/avatar-react";
import "@bible-strong/avatar-react/styles.css";
import {
  sentinelAvatarDefinition,
  type SentinelAnimation,
  type SentinelExpression,
} from "@/lib/sentinelAvatar";

export type HandGesture =
  | "auto"
  | "wave"
  | "point-left"
  | "point-right"
  | "point-down"
  | "point-up"
  | "shield"
  | "thinking"
  | "alert"
  | "idle";

interface SentinelAvatarProps {
  size?: number | string;
  animation?: SentinelAnimation;
  expression?: SentinelExpression;
  handGesture?: HandGesture;
  className?: string;
  onClick?: () => void;
  ariaLabel?: string;
}

const PALETTES: Record<
  SentinelExpression,
  { line: string; accent: string; hand: string; handLight: string }
> = {
  neutral: { line: "#e0f2fe", accent: "#9ba9ff", hand: "#001b85", handLight: "#002bbd" },
  explaining: { line: "#f0f9ff", accent: "#38bdf8", hand: "#0369a1", handLight: "#0ea5e9" },
  happy: { line: "#ffffff", accent: "#67e8f9", hand: "#0e7490", handLight: "#22d3ee" },
  thinking: { line: "#f3e8ff", accent: "#c084fc", hand: "#5b21b6", handLight: "#8b5cf6" },
  alert: { line: "#fee2e2", accent: "#f87171", hand: "#991b1b", handLight: "#ef4444" },
  secure: { line: "#ecfdf5", accent: "#34d399", hand: "#065f46", handLight: "#10b981" },
};

function firstExpressionOf(animation: SentinelAnimation | undefined): SentinelExpression {
  const step = animation && sentinelAvatarDefinition.animations[animation]?.steps[0];
  return (step?.expression as SentinelExpression) ?? "neutral";
}

function gestureFor(expr: SentinelExpression): HandGesture {
  switch (expr) {
    case "happy":
      return "wave";
    case "explaining":
      return "point-left";
    case "thinking":
      return "thinking";
    case "alert":
      return "alert";
    case "secure":
      return "shield";
    default:
      return "idle";
  }
}

export function SentinelAvatar({
  size = 58,
  animation,
  expression,
  handGesture = "auto",
  className = "",
  onClick,
  ariaLabel = "Aegis Helper avatar",
}: SentinelAvatarProps) {
  const [mounted, setMounted] = useState(false);
  // useId output can contain characters that break url(#id) references
  const uid = "sentinel" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  // The expression the engine is actually showing right now. Animations cycle
  // through several expressions, so the overlay must follow the engine rather
  // than the props.
  const [liveExpr, setLiveExpr] = useState<SentinelExpression>(
    expression ?? firstExpressionOf(animation)
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only mount gate
    setMounted(true);
  }, []);

  const [prevTarget, setPrevTarget] = useState({ animation, expression });
  if (prevTarget.animation !== animation || prevTarget.expression !== expression) {
    setPrevTarget({ animation, expression });
    setLiveExpr(expression ?? firstExpressionOf(animation));
  }

  const numSize = typeof size === "number" ? size : parseInt(String(size), 10) || 58;

  if (!mounted) {
    return (
      <div
        className={`relative inline-flex items-center justify-center rounded-full bg-primary ${className}`}
        style={{ width: numSize, height: numSize }}
      >
        <div className="w-1/2 h-1/2 rounded-full bg-on-primary/20 animate-pulse" />
      </div>
    );
  }

  const avatarProps = animation
    ? { animation }
    : expression
    ? { expression }
    : { defaultAnimation: "idle" as const };

  const gesture = handGesture === "auto" ? gestureFor(liveExpr) : handGesture;
  const palette = PALETTES[liveExpr] ?? PALETTES.neutral;

  // Keep the mouth/brows attached to the face as the head turns.
  const head = sentinelAvatarDefinition.expressions[liveExpr]?.head ?? { x: 0, y: 0 };
  const faceShift = `translate(${head.x * 0.3}px, ${head.y * 0.3}px)`;

  const handSize = numSize * 0.28;
  const handTop = numSize * 0.56;

  const leftHandMotion =
    gesture === "point-left"
      ? { animation: "sentinelPointL 1.4s ease-in-out infinite" }
      : gesture === "alert"
      ? { transform: "translate(-2px, -6px) rotate(18deg)" }
      : gesture === "shield"
      ? { transform: "translate(4px, -2px) rotate(14deg)" }
      : { animation: "sentinelFloat 3.4s ease-in-out infinite" };

  const rightHandMotion =
    gesture === "wave"
      ? { animation: "sentinelWave 1.6s ease-in-out infinite", transformOrigin: "50% 90%" }
      : gesture === "point-right"
      ? { animation: "sentinelPointR 1.4s ease-in-out infinite" }
      : gesture === "point-down"
      ? { transform: "translateY(4px) rotate(160deg)" }
      : gesture === "point-up"
      ? { transform: "translateY(-8px)" }
      : gesture === "thinking"
      ? { animation: "sentinelChin 2.4s ease-in-out infinite" }
      : gesture === "alert"
      ? { transform: "translate(2px, -6px) rotate(-18deg)" }
      : gesture === "shield"
      ? { transform: "translate(-4px, -2px) rotate(-14deg)" }
      : { animation: "sentinelFloat 3.4s ease-in-out 0.6s infinite" };

  const isSpeaking = liveExpr === "explaining";

  return (
    <div
      onClick={onClick}
      className={`relative inline-block select-none transition-transform duration-300 hover:scale-105 active:scale-95 ${className}`}
      style={{ width: numSize, height: numSize }}
    >
      <style>{`
        @keyframes sentinelSpeak {
          0%, 100% { transform: scaleY(0.55); }
          30% { transform: scaleY(1.1); }
          60% { transform: scaleY(0.75); }
          80% { transform: scaleY(1); }
        }
        @keyframes sentinelBlush {
          0%, 100% { opacity: 0.25; }
          50% { opacity: 0.5; }
        }
        @keyframes sentinelFloat {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-2px); }
        }
        @keyframes sentinelWave {
          0%, 100% { transform: translateY(-8px) rotate(-6deg); }
          25% { transform: translateY(-8px) rotate(14deg); }
          50% { transform: translateY(-8px) rotate(-10deg); }
          75% { transform: translateY(-8px) rotate(10deg); }
        }
        @keyframes sentinelPointL {
          0%, 100% { transform: translate(-3px, -2px) rotate(-70deg); }
          50% { transform: translate(-6px, -2px) rotate(-70deg); }
        }
        @keyframes sentinelPointR {
          0%, 100% { transform: translate(3px, -2px) rotate(70deg); }
          50% { transform: translate(6px, -2px) rotate(70deg); }
        }
        @keyframes sentinelChin {
          0%, 100% { transform: translate(-30%, -6px) rotate(-12deg); }
          50% { transform: translate(-30%, -8px) rotate(-6deg); }
        }
        .sentinel-hand, .sentinel-face { transition: transform 450ms cubic-bezier(.34,1.3,.64,1); }
        @media (prefers-reduced-motion: reduce) {
          .sentinel-hand, .sentinel-anim { animation: none !important; }
        }
      `}</style>

      <div className="relative w-full h-full rounded-full overflow-hidden flex items-center justify-center drop-shadow-md">
        <Avatar
          definition={sentinelAvatarDefinition}
          size={numSize}
          autoplay={true}
          ariaLabel={ariaLabel}
          className="relative z-10 w-full h-full"
          onExpressionChange={(e) => setLiveExpr(e as SentinelExpression)}
          {...avatarProps}
        />
      </div>

      {/* Mouth, brows and cheeks, drawn over the engine's face */}
      <div className="absolute inset-0 pointer-events-none z-20">
        <svg viewBox="0 0 100 100" className="w-full h-full">
          <g className="sentinel-face" style={{ transform: faceShift }}>
            {liveExpr === "alert" ? (
              <g stroke={palette.line} strokeWidth="2" strokeLinecap="round" fill="none">
                <path d="M 34 31 Q 40 29 46 33" />
                <path d="M 54 33 Q 60 29 66 31" />
              </g>
            ) : liveExpr === "thinking" ? (
              <g stroke={palette.line} strokeWidth="1.8" strokeLinecap="round" fill="none" opacity="0.9">
                <path d="M 34 30 Q 40 26 46 29" />
                <path d="M 54 32 Q 60 32 66 33" />
              </g>
            ) : null}

            {(liveExpr === "happy" || liveExpr === "secure") && (
              <g className="sentinel-anim" style={{ animation: "sentinelBlush 3s ease-in-out infinite" }}>
                <ellipse cx="30" cy="56" rx="5" ry="2.6" fill={palette.accent} />
                <ellipse cx="70" cy="56" rx="5" ry="2.6" fill={palette.accent} />
              </g>
            )}

            {isSpeaking ? (
              <g
                className="sentinel-anim"
                style={{ transformOrigin: "50px 63px", animation: "sentinelSpeak 0.9s ease-in-out infinite" }}
              >
                <path d="M 44 61 Q 50 60 56 61 Q 55 67 50 67 Q 45 67 44 61 Z" fill="#0b1b33" stroke={palette.line} strokeWidth="1.4" strokeLinejoin="round" />
              </g>
            ) : liveExpr === "happy" ? (
              <path d="M 42 60 Q 50 68 58 60" stroke={palette.line} strokeWidth="2.2" strokeLinecap="round" fill="none" />
            ) : liveExpr === "thinking" ? (
              <path d="M 45 63 Q 50 63 55 61" stroke={palette.line} strokeWidth="1.8" strokeLinecap="round" fill="none" />
            ) : liveExpr === "alert" ? (
              <ellipse cx="50" cy="64" rx="3.6" ry="4.4" fill="#2b0314" stroke={palette.line} strokeWidth="1.4" />
            ) : liveExpr === "secure" ? (
              <path d="M 44 61 Q 50 66 56 61" stroke={palette.line} strokeWidth="2" strokeLinecap="round" fill="none" />
            ) : (
              <path d="M 45 62 Q 50 64.5 55 62" stroke={palette.line} strokeWidth="1.7" strokeLinecap="round" fill="none" opacity="0.9" />
            )}
          </g>
        </svg>
      </div>

      {/* Hands: rounded mittens that tuck against the body */}
      {(
        [
          ["left", leftHandMotion],
          ["right", rightHandMotion],
        ] as const
      ).map(([side, motion]) => {
        const pointing =
          (side === "left" && gesture === "point-left") ||
          (side === "right" && ["point-right", "point-up", "point-down"].includes(gesture));
        return (
          <div
            key={side}
            className="sentinel-hand absolute z-30 pointer-events-none"
            style={{
              [side]: -numSize * 0.08,
              top: handTop,
              width: handSize,
              height: handSize,
              ...motion,
            }}
          >
            <svg viewBox="0 0 32 32" className="w-full h-full overflow-visible">
              <defs>
                <radialGradient id={`${uid}-hand-${side}`} cx="40%" cy="35%" r="70%">
                  <stop offset="0%" stopColor={palette.handLight} />
                  <stop offset="100%" stopColor={palette.hand} />
                </radialGradient>
              </defs>
              {pointing && (
                <rect x="13" y="1" width="6" height="14" rx="3" fill={`url(#${uid}-hand-${side})`} stroke={palette.accent} strokeWidth="0.8" />
              )}
              <ellipse cx="16" cy="18" rx="10" ry="9" fill={`url(#${uid}-hand-${side})`} stroke={palette.accent} strokeWidth="0.8" />
              {/* thumb */}
              <ellipse
                cx={side === "left" ? 25 : 7}
                cy="16"
                rx="3.4"
                ry="4.4"
                transform={`rotate(${side === "left" ? 25 : -25} ${side === "left" ? 25 : 7} 16)`}
                fill={palette.handLight}
                stroke={palette.accent}
                strokeWidth="0.8"
              />
              <ellipse cx="13" cy="14" rx="3" ry="1.6" fill="#ffffff" opacity="0.25" />
            </svg>
          </div>
        );
      })}
    </div>
  );
}
