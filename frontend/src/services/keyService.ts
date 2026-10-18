import { api } from "@/lib/api";
import type { APIKeyResponse, APIKeyCreate, APIKeyCreateResponse } from "@/lib/types";

export const keyService = {
  /** GET /api/v1/keys/ */
  listKeys: () => api.get<APIKeyResponse[]>("/api/v1/keys/"),

  /** POST /api/v1/keys/ */
  createKey: (payload: APIKeyCreate) =>
    api.post<APIKeyCreateResponse>("/api/v1/keys/", payload),

  /** DELETE /api/v1/keys/{key_id} */
  revokeKey: (keyId: string) => api.delete<void>(`/api/v1/keys/${keyId}`),
};
