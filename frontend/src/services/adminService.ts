import { api } from "@/lib/api";
import type {
  AdminUserResponse,
  AdminUserCreate,
  AdminStatusUpdate,
  RoleAssignRequest,
  AuditLogEntry,
} from "@/lib/types";

export const adminService = {
  /** GET /api/v1/admins/ */
  listAdmins: () => api.get<AdminUserResponse[]>("/api/v1/admins/"),

  /** POST /api/v1/admins/ */
  createAdmin: (payload: AdminUserCreate) =>
    api.post<AdminUserResponse>("/api/v1/admins/", payload),

  /** PATCH /api/v1/admins/{admin_id}/status */
  updateStatus: (adminId: string, status: string) =>
    api.patch<void>(`/api/v1/admins/${adminId}/status`, {
      status,
    } satisfies AdminStatusUpdate),

  /** GET /api/v1/admins/roles */
  listRoles: () => api.get<string[]>("/api/v1/admins/roles"),

  /** POST /api/v1/admins/{admin_id}/roles */
  assignRole: (adminId: string, roleName: string, companySlug?: string) =>
    api.post<void>(`/api/v1/admins/${adminId}/roles`, {
      role_name: roleName,
      company_slug: companySlug || null,
    } satisfies RoleAssignRequest),

  /** DELETE /api/v1/admins/{admin_id}/roles/{role_id} */
  revokeRole: (adminId: string, roleId: string) =>
    api.delete<void>(`/api/v1/admins/${adminId}/roles/${roleId}`),

  /** GET /api/v1/admins/audit-logs */
  getAuditLogs: (limit = 50, offset = 0) =>
    api.get<AuditLogEntry[]>("/api/v1/admins/audit-logs", {
      params: { limit, offset },
    }),

  /** GET /api/v1/admins/clients */
  listClients: () => api.get<Record<string, unknown>[]>("/api/v1/admins/clients"),

  /** GET /api/v1/admins/clients/{slug} */
  getClient: (slug: string) =>
    api.get<Record<string, unknown>>(`/api/v1/admins/clients/${slug}`),
};
