import { api } from "@/lib/api";
import type { DecoyResponse } from "@/lib/types";

export const decoyService = {
  /** GET /api/v1/decoys/ */
  listDecoys: (status?: string) => {
    const params: Record<string, string> = {};
    if (status) params.status = status;
    return api.get<DecoyResponse[]>("/api/v1/decoys/", { params });
  },

  /** GET /api/v1/decoys/{decoy_id} */
  getDecoy: (decoyId: string) =>
    api.get<DecoyResponse>(`/api/v1/decoys/${decoyId}`),
};
