import { api } from "@/lib/api";
import type { AgentResponse, AgentRegistryResponse } from "@/lib/types";

export const agentService = {
  /** GET /api/v1/agents/ — Direct full agent registry with cryptographic proofs */
  listAgents: () => api.get<AgentRegistryResponse[]>("/api/v1/agents/"),

  /** GET /api/v1/dashboard/agents — High-speed dashboard agent view */
  getAgents: () => api.get<AgentResponse[]>("/api/v1/dashboard/agents"),

  /** GET /api/v1/dashboard/agents/metrics */
  getMetrics: () => api.get<Record<string, unknown>>("/api/v1/dashboard/agents/metrics"),

  /** POST /api/v1/agents/{agent_id}/decommission */
  decommission: (agentId: string) =>
    api.post<void>(`/api/v1/agents/${agentId}/decommission`),

  /** POST /api/v1/agents/{agent_id}/recommission */
  recommission: (agentId: string) =>
    api.post<void>(`/api/v1/agents/${agentId}/recommission`),
};
