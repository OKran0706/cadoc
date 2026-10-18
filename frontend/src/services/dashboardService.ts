import { api, createEventSource } from "@/lib/api";
import type {
  SummaryKPIs,
  HeatmapCell,
  PagedAlerts,
  MitigatePayload,
} from "@/lib/types";

export const dashboardService = {
  /** GET /api/v1/dashboard/summary */
  getSummary: () => api.get<SummaryKPIs>("/api/v1/dashboard/summary"),

  /** GET /api/v1/dashboard/detections/heatmap */
  getHeatmap: () => api.get<HeatmapCell[]>("/api/v1/dashboard/detections/heatmap"),

  /** GET /api/v1/dashboard/alerts?cursor=…&limit=… */
  getAlerts: (cursor?: string, limit = 20) => {
    const params: Record<string, string | number> = { limit };
    if (cursor) params.cursor = cursor;
    return api.get<PagedAlerts>("/api/v1/dashboard/alerts", { params });
  },

  /** POST /api/v1/dashboard/alerts/{alert_id}/mitigate */
  mitigateAlert: (alertId: string, notes?: string) =>
    api.post<void>(`/api/v1/dashboard/alerts/${alertId}/mitigate`, {
      notes: notes || null,
    } satisfies MitigatePayload),

  /** POST /api/v1/dashboard/alerts/{alert_id}/quarantine */
  quarantineAlert: (alertId: string, killParent: boolean) =>
    api.post<void>(`/api/v1/dashboard/alerts/${encodeURIComponent(alertId)}/quarantine`, {
      kill_parent: killParent,
    }),

  /** SSE stream: GET /api/v1/dashboard/alerts/stream */
  getAlertStream: () => createEventSource("/api/v1/dashboard/alerts/stream"),

  /** GET /api/v1/dashboard/reports/export */
  exportReport: () => api.get<Blob>("/api/v1/dashboard/reports/export"),
};
