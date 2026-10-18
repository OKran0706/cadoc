import { api } from "@/lib/api";
import type { ProjectResponse, ProjectCreate } from "@/lib/types";

export const projectService = {
  /** GET /api/v1/projects/ */
  listProjects: () => api.get<ProjectResponse[]>("/api/v1/projects/"),

  /** POST /api/v1/projects/ */
  createProject: (payload: ProjectCreate) =>
    api.post<ProjectResponse>("/api/v1/projects/", payload),
};
