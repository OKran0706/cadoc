import { api } from "@/lib/api";
import type { NodeInventory, JoinResponse, VerifyRequest, VerifyResponse } from "@/lib/types";

export const nodeService = {
  /** GET /api/v1/dashboard/nodes */
  getNodes: () => api.get<NodeInventory[]>("/api/v1/dashboard/nodes"),

  /** POST /api/v1/dashboard/servers/token — generate a join token for a server */
  generateToken: (serverId: string) =>
    api.post<JoinResponse>("/api/v1/dashboard/servers/token", { server_id: serverId }),

  /** POST /api/v1/dashboard/servers/verify — verify a server registration */
  verifyServer: (serverId: string) =>
    api.post<VerifyResponse>("/api/v1/dashboard/servers/verify", {
      server_id: serverId,
    } satisfies VerifyRequest),
};
