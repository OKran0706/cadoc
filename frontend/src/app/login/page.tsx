"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  ShieldAlert,
  KeyRound,
  Server,
  Activity,
  ShieldCheck,
  ArrowRight,
} from "lucide-react";
import { login } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();

  // Form state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companySlug, setCompanySlug] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Handle Login submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMessage(null);

    try {
      await login(email, password, companySlug.trim());
      router.push("/");
    } catch (err) {
      setErrorMessage(
        err instanceof Error && err.message
          ? err.message
          : "Unable to sign in. Please try again."
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex bg-surface text-on-surface">
      {/* LEFT PANE - Form Content (5/12 width on large, full width on small) */}
      <div className="w-full lg:w-5/12 flex flex-col justify-between p-8 sm:p-12 md:p-16 lg:p-20 bg-surface-container-lowest z-10 shadow-xl">
        {/* Top Header - Logo */}
        <div className="flex items-center gap-3 select-none">
          <img
            src="/cadoc-logo-mark.png"
            alt="CADOC Sentinel"
            className="w-12 h-12 object-contain shrink-0 drop-shadow-sm"
          />
          <div>
            <div className="flex items-baseline gap-1.5 leading-none">
              <span className="font-headline font-black text-xl tracking-tight text-[#002D80]">
                CADOC
              </span>
              <span className="font-headline font-black text-xl tracking-wider text-[#002D80]">
                SENTINEL
              </span>
            </div>
            <span className="text-[10px] font-semibold text-on-surface-variant/70 tracking-[0.2em] uppercase block mt-1.5">
              Security Platform
            </span>
          </div>
        </div>

        {/* Middle Content - Login Form */}
        <div className="my-auto max-w-md w-full mx-auto space-y-6 py-8">
          <div>
            <h1 className="text-2xl font-bold font-headline text-on-surface tracking-tight">
              Log in to your account
            </h1>
            <p className="text-sm text-on-surface-variant mt-1.5">
              Enter your credential profile to access the security console.
            </p>
          </div>

          {errorMessage && (
            <div className="flex items-start gap-2.5 p-3.5 bg-error-container/20 border border-error/20 rounded-xl text-error text-xs animate-[fadeIn_0.2s_ease-out]">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Organization / Tenant Field */}
            <div className="space-y-1.5">
              <label
                className="text-xs font-semibold text-on-surface-variant"
                htmlFor="companySlug"
              >
                Organization (Tenant)
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-on-surface-variant/40">
                  <Server className="w-4 h-4" />
                </div>
                <input
                  id="companySlug"
                  type="text"
                  required
                  placeholder="Enter organization slug (e.g. acme-corp)"
                  value={companySlug}
                  onChange={(e) => setCompanySlug(e.target.value)}
                  disabled={isLoading}
                  className="w-full bg-surface-container-low border border-outline-variant/30 rounded-xl pl-10 pr-4 py-3 text-sm font-mono text-on-surface placeholder:text-on-surface-variant/40 outline-none transition-all focus:border-primary/45 focus:ring-2 focus:ring-primary/10"
                />
              </div>
            </div>

            {/* Email Field */}
            <div className="space-y-1.5">
              <label
                className="text-xs font-semibold text-on-surface-variant"
                htmlFor="email"
              >
                Email Address
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-on-surface-variant/40">
                  <Mail className="w-4 h-4" />
                </div>
                <input
                  id="email"
                  type="email"
                  required
                  placeholder="admin@cadoc.io"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isLoading}
                  className="w-full bg-surface-container-low border border-outline-variant/30 rounded-xl pl-10 pr-4 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/40 outline-none transition-all focus:border-primary/45 focus:ring-2 focus:ring-primary/10"
                />
              </div>
            </div>

            {/* Password Field */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <label
                  className="text-xs font-semibold text-on-surface-variant"
                  htmlFor="password"
                >
                  Password
                </label>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    alert(
                      "Please contact your organization's system administrator to reset credentials."
                    );
                  }}
                  className="text-xs font-medium text-primary hover:underline hover:text-primary-container"
                >
                  Forgot password?
                </a>
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-on-surface-variant/40">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  required
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isLoading}
                  className="w-full bg-surface-container-low border border-outline-variant/30 rounded-xl pl-10 pr-10 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/40 outline-none transition-all focus:border-primary/45 focus:ring-2 focus:ring-primary/10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-on-surface-variant/40 hover:text-on-surface transition-colors"
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-primary text-on-primary hover:bg-primary-container font-semibold text-sm py-3 rounded-xl shadow-lg shadow-primary/15 transition-all flex items-center justify-center gap-2 disabled:opacity-75 disabled:cursor-not-allowed mt-6 active:scale-[0.98]"
            >
              {isLoading ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Authenticating...
                </>
              ) : (
                <>
                  Log In
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>

        {/* Footer info */}
        <div className="text-[11px] text-on-surface-variant/60 text-center max-w-sm mx-auto">
          Need access to the CADOC Sentinel ecosystem? Contact your security
          administrator or deployment lead.
        </div>
      </div>

      {/* RIGHT PANE - Visual Showcase (7/12 width, hidden on small screens) */}
      <div className="hidden lg:flex lg:w-7/12 bg-gradient-to-br from-[#000a30] via-[#001460] to-[#002bbd] relative overflow-hidden items-center justify-center p-12">
        {/* Background decorative glow elements */}
        <div className="absolute top-1/4 left-1/4 w-[350px] h-[350px] rounded-full bg-primary-container opacity-25 blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-secondary-container opacity-15 blur-3xl" />

        {/* Main showcase container */}
        <div className="z-10 w-full max-w-lg space-y-8 text-white">
          <div className="space-y-4">
            <h2 className="text-4xl font-headline font-bold leading-tight -tracking-wide">
              Defend Your Infrastructure.
            </h2>
            <p className="text-sm text-on-primary-container/85 max-w-md font-medium leading-relaxed">
              CADOC Sentinel is a cyber-deception security platform. It monitors your server infrastructure and deploys network traps (decoys) to detect and block threats in real-time.
            </p>
          </div>

          {/* Infinite Vertical Scrolling Showcase Marquee */}
          <div className="relative h-[330px] overflow-hidden rounded-2xl w-full">
            {/* Soft faded mask overlays at top & bottom */}
            <div className="absolute top-0 inset-x-0 h-12 bg-gradient-to-b from-[#001460] to-transparent z-20 pointer-events-none" />
            <div className="absolute bottom-0 inset-x-0 h-12 bg-gradient-to-t from-[#001460] to-transparent z-20 pointer-events-none" />

            <style>{`
              @keyframes marqueeVertical {
                0% {
                  transform: translateY(0);
                }
                100% {
                  transform: translateY(-50%);
                }
              }
            `}</style>

            <div className="flex flex-col gap-4 animate-[marqueeVertical_30s_linear_infinite] hover:[animation-play-state:paused] w-full">
              {/* Set 1 */}
              <div className="space-y-4">
                {/* Mockup 1: Sensor Fleet Overview */}
                <div className="glass-panel backdrop-blur-2xl bg-white/90 border border-white/20 rounded-2xl p-5 shadow-2xl space-y-4 hover:bg-white transition-colors text-slate-800">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Server className="w-5 h-5 text-primary" />
                      <span className="font-bold text-sm tracking-wide text-slate-900">
                        Sensor Fleet Overview
                      </span>
                    </div>
                    <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-full border border-emerald-200">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      100% Covered
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-3 pt-1">
                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-200/50">
                      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none">
                        Active Sensors
                      </p>
                      <p className="text-lg font-bold text-slate-900 mt-1.5 font-mono">3,142</p>
                    </div>
                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-200/50">
                      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none">
                        Deployed Decoys
                      </p>
                      <p className="text-lg font-bold text-slate-900 mt-1.5 font-mono">38</p>
                    </div>
                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-200/50">
                      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none">
                        Threats (24h)
                      </p>
                      <p className="text-lg font-bold mt-1.5 font-mono text-emerald-600">14</p>
                    </div>
                  </div>
                </div>

                {/* Mockup 2: Real-time Deception Alert */}
                {/* <div className="glass-panel backdrop-blur-2xl bg-white/90 border border-white/20 rounded-2xl p-4 shadow-2xl flex items-center justify-between w-11/12 ml-auto hover:bg-white transition-colors text-slate-800">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-red-50 text-red-500 rounded-lg shrink-0">
                      <ShieldAlert className="w-4.5 h-4.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-900 truncate">
                        Honey DB Decoy Triggered
                      </p>
                      <p className="text-[10px] text-slate-500 truncate">
                        Unauthorized query by Actor: 45.138.74.22
                      </p>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-red-600 shrink-0 ml-2 bg-red-50 px-2 py-0.5 rounded-md border border-red-100">
                    10s ago
                  </span>
                </div> */}

                {/* Mockup 3: Telemetry Ingestion Pipeline */}
                <div className="glass-panel backdrop-blur-2xl bg-white/90 border border-white/20 rounded-2xl p-4 shadow-2xl flex items-center justify-between w-10/12 mr-auto hover:bg-white transition-colors text-slate-800">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary/10 text-primary rounded-lg shrink-0">
                      <Activity className="w-4.5 h-4.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-900">
                        Telemetry Ingestion
                      </p>
                      <p className="text-[10px] text-slate-500 truncate">
                        Ingesting 14.8k events/sec • Drops: 0.00%
                      </p>
                    </div>
                  </div>
                  <span className="text-xs font-bold text-slate-900 font-mono shrink-0 ml-2">12ms</span>
                </div>
              </div>

              {/* Set 2 (Duplicate for seamless loop) */}
              <div className="space-y-4">
                {/* Mockup 1: Sensor Fleet Overview */}
                <div className="glass-panel backdrop-blur-2xl bg-white/90 border border-white/20 rounded-2xl p-5 shadow-2xl space-y-4 hover:bg-white transition-colors text-slate-800">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Server className="w-5 h-5 text-primary" />
                      <span className="font-bold text-sm tracking-wide text-slate-900">
                        Sensor Fleet Overview
                      </span>
                    </div>
                    <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-full border border-emerald-200">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      100% Covered
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-3 pt-1">
                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-200/50">
                      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none">
                        Active Sensors
                      </p>
                      <p className="text-lg font-bold text-slate-900 mt-1.5 font-mono">3,142</p>
                    </div>
                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-200/50">
                      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none">
                        Deployed Decoys
                      </p>
                      <p className="text-lg font-bold text-slate-900 mt-1.5 font-mono">38</p>
                    </div>
                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-200/50">
                      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none">
                        Threats (24h)
                      </p>
                      <p className="text-lg font-bold mt-1.5 font-mono text-emerald-600">14</p>
                    </div>
                  </div>
                </div>

                {/* Mockup 2: Real-time Deception Alert */}
                {/* <div className="glass-panel backdrop-blur-2xl bg-white/90 border border-white/20 rounded-2xl p-4 shadow-2xl flex items-center justify-between w-11/12 ml-auto hover:bg-white transition-colors text-slate-800">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-red-50 text-red-500 rounded-lg shrink-0">
                      <ShieldAlert className="w-4.5 h-4.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-900 truncate">
                        Honey DB Decoy Triggered
                      </p>
                      <p className="text-[10px] text-slate-500 truncate">
                        Unauthorized query by Actor: 45.138.74.22
                      </p>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-red-600 shrink-0 ml-2 bg-red-50 px-2 py-0.5 rounded-md border border-red-100">
                    10s ago
                  </span>
                </div> */}

                {/* Mockup 3: Telemetry Ingestion Pipeline */}
                <div className="glass-panel backdrop-blur-2xl bg-white/90 border border-white/20 rounded-2xl p-4 shadow-2xl flex items-center justify-between w-10/12 mr-auto hover:bg-white transition-colors text-slate-800">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary/10 text-primary rounded-lg shrink-0">
                      <Activity className="w-4.5 h-4.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-900">
                        Telemetry Ingestion
                      </p>
                      <p className="text-[10px] text-slate-500 truncate">
                        Ingesting 14.8k events/sec • Drops: 0.00%
                      </p>
                    </div>
                  </div>
                  <span className="text-xs font-bold text-slate-900 font-mono shrink-0 ml-2">12ms</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Decorative corner lines / brackets */}
        <div className="absolute top-6 right-6 text-white/10 font-mono text-xs select-none">
          SYSTEM_VERSION_4.2.1-SEC
        </div>
      </div>
    </div>
  );
}
