import { api } from "@/lib/api";
import type { ServerResponse, ServerCreate } from "@/lib/types";

export const serverService = {
  /** GET /api/v1/servers/ */
  listServers: () => api.get<ServerResponse[]>("/api/v1/servers/"),

  /** POST /api/v1/servers/ */
  createServer: (payload: ServerCreate) =>
    api.post<ServerResponse>("/api/v1/servers/", payload),
};
