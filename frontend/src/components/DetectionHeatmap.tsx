"use client";

import { useState, useEffect } from "react";
import { dashboardService } from "@/services/dashboardService";
import type { HeatmapCell } from "@/lib/types";

const intensityClass = (intensity: number): string => {
  if (intensity >= 8) return "bg-red-500";
  if (intensity >= 6) return "bg-orange-400";
  if (intensity >= 4) return "bg-primary";
  if (intensity >= 2) return "bg-primary-container";
  if (intensity >= 1) return "bg-white/20";
  return "bg-white/5";
};

export function DetectionHeatmap() {
  const [cells, setCells] = useState<HeatmapCell[]>([]);
  const [loading, setLoading] = useState(true);

  const loadHeatmap = (silent = false) => {
    if (!silent) setLoading(true);
    dashboardService
      .getHeatmap()
      .then((data) => {
        setCells(Array.isArray(data) ? data : []);
        if (!silent) setLoading(false);
      })
      .catch((err) => {
        console.error("Heatmap load error:", err);
        if (!silent) setLoading(false);
      });
  };

  useEffect(() => {
    loadHeatmap(false);
    const interval = setInterval(() => {
      loadHeatmap(true);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Build a 2D grid from API data
  const maxRow = cells.reduce((m, c) => Math.max(m, c.row), 1);
  const maxCol = cells.reduce((m, c) => Math.max(m, c.col), 11);
  const grid: (HeatmapCell | null)[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    grid[r] = [];
    for (let c = 0; c <= maxCol; c++) {
      grid[r][c] = cells.find((cell) => cell.row === r && cell.col === c) || null;
    }
  }

  // Compute average intensity for risk index
  const avgIntensity =
    cells.length > 0
      ? (cells.reduce((sum, c) => sum + c.intensity, 0) / cells.length).toFixed(1)
      : "0.0";
  const riskLabel =
    Number(avgIntensity) >= 6
      ? "High"
      : Number(avgIntensity) >= 3
        ? "Medium"
        : "Low";

  // Fallback to static grid when no data
  const hasData = cells.length > 0;

  return (
    <div className="bg-tertiary rounded-xl p-5 text-white mt-4 shadow-lg">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-headline font-bold text-base">
          Detection Risk Scoring
        </h3>
        <div className="text-[9px] font-bold uppercase tracking-widest bg-white/10 px-2.5 py-1 rounded-full">
          Global Heatmap
        </div>
      </div>

      {loading ? (
        <div className="h-24 flex items-center justify-center">
          <span className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
        </div>
      ) : hasData ? (
        <div
          className="gap-1.5"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${maxCol + 1}, 1fr)`,
            minHeight: "6rem",
          }}
        >
          {grid.flat().map((cell, i) => (
            <div
              key={cell?.id || `empty-${i}`}
              className={`${cell ? intensityClass(cell.intensity) : "bg-white/5"} rounded-sm hover:bg-white/30 transition-colors cursor-default`}
              title={
                cell
                  ? `${cell.hostname} (${cell.location}) — Intensity: ${cell.intensity}`
                  : undefined
              }
            />
          ))}
        </div>
      ) : (
        /* Fallback static grid when API returns empty */
        <div className="grid grid-cols-12 gap-1.5 h-24">
          {Array.from({ length: 24 }).map((_, i) => (
            <div
              key={i}
              className="bg-white/5 rounded-sm hover:bg-white/20 transition-colors"
            />
          ))}
        </div>
      )}

      <div className="mt-3 flex justify-between items-center text-[10px] text-white/50 font-medium">
        <span>
          {hasData
            ? `${cells.length} detection zones active`
            : "No detection data available"}
        </span>
        <span>
          Risk Index: {avgIntensity} {riskLabel}
        </span>
      </div>
    </div>
  );
}
