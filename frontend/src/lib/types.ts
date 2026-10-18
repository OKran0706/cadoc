// ─── Cadoc Platform API Types ───────────────────────────────────────────────
// Derived from OpenAPI spec at https://ec2-3-89-18-5.compute-1.amazonaws.com/openapi.json

// ─── Auth ───
export interface LoginRequest {
  email: string;
  password: string;
  company_slug?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  role?: string | null;
  roles?: string[] | null;
  user?: {
    id?: string;
    email?: string;
    name?: string;
    display_name?: string;
    role?: string | null;
    roles?: string[] | null;
  } | null;
}

// ─── Projects ───
export interface ProjectCreate {
  name: string;
  description?: string | null;
  company_slug?: string | null;
}

export interface ProjectResponse {
  id: string;
  name: string;
  description?: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Servers ───
export interface ServerCreate {
  project_id: string;
  hostname: string;
  ip_address: string;
  status?: string | null;
  specs?: Record<string, unknown> | null;
  company_slug?: string | null;
}

export interface ServerResponse {
  id: string;
  project_id: string;
  hostname: string;
  ip_address: string;
  status: string;
  specs: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ─── Dashboard Summary ───
export interface SummaryKPIs {
  criticalAlerts: number;
  mitigatedIncidents: number;
  activeAnalysts: number;
  networkUptime: string | number;
}

// ─── Heatmap ───
export interface HeatmapCell {
  id: string;
  hostname: string;
  location: string;
  project: string;
  row: number;
  col: number;
  intensity: number;
}

// ─── Alerts ───
export interface AlertPayload {
  id: string;
  server_id: string;
  hostname?: string;
  host_name?: string;
  event_type: string;
  severity: string;
  details: Record<string, unknown>;
  detected_at: string;
  status?: string;
}

export interface PagedAlerts {
  data: AlertPayload[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface MitigatePayload {
  notes?: string | null;
}

// ─── Nodes ───
export interface NodeInventory {
  id: string;
  hostname?: string;
  host_name?: string;
  host?: string;
  name?: string;
  server_hostname?: string;
  server_id?: string;
  serverId?: string;
  location: string;
  ip: string;
  status: string;
  cpu: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  threats: number;
}

// ─── Agents ───
export interface AgentResponse {
  id: string;
  server_id: string;
  version: string | null;
  git_commit: string | null;
  status: string;
  last_connected_at: string | null;
}

export interface AgentRegistryResponse extends AgentResponse {
  capabilities_proof: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ─── Decoys ───
export interface DecoyResponse {
  id: string;
  server_id: string;
  file_path: string;
  decoy_type: string;
  original_hash: string;
  status: string;
  planted_at: string;
  last_verified: string | null;
  created_at: string;
  updated_at: string;
}

// ─── API Keys ───
export interface APIKeyResponse {
  id: string;
  name: string;
  created_at: string;
  expires_at?: string | null;
  revoked_at?: string | null;
}

export interface APIKeyCreate {
  name: string;
  expires_in_days?: number | null;
}

export interface APIKeyCreateResponse {
  id: string;
  name: string;
  plain_text_key: string;
  created_at: string;
  expires_at?: string | null;
}

// ─── Admin ───
export interface AdminUserResponse {
  id: string;
  email: string;
  display_name: string;
  status: string;
  auth_provider: string;
  created_at: string;
  roles: string[];
}

export interface AdminUserCreate {
  email: string;
  display_name: string;
  password: string;
}

export interface AdminStatusUpdate {
  status: string;
}

export interface RoleAssignRequest {
  role_name: string;
  company_slug?: string | null;
}

export interface AuditLogEntry {
  id?: string;
  actor?: string;
  user?: string;
  action: string;
  entity_type?: string;
  entity_id?: string;
  details?: Record<string, unknown>;
  timestamp?: string;
  ts?: string;
  ip_address?: string;
  resource_type?: string;
  status?: string;
  target?: string;
  notes?: string;
  created_at?: string;
  resource_id?: string;
  severity?: string;
  node_id?: string;
}

// ─── Bootstrap / Onboarding ───
export interface JoinRequest {
  server_id: string;
}

export interface JoinResponse {
  token: string;
  expires_at: number;
  install_command: string;
}

export interface VerifyRequest {
  server_id: string;
}

export interface VerifyResponse {
  verified: boolean;
  status: string;
}

export interface OnboardRequest {
  slug: string;
  name: string;
}

// ─── Health ───
export interface HealthResponse {
  status: string;
  service: string;
}

// ─── RBAC & User Roles ───
export type UserRole =
  | "platform_owner"
  | "tenant-admin"
  | "security-analyst"
  | "read-only";

export type Permission =
  | "*"
  | "project.manage"
  | "project.read"
  | "server.manage"
  | "server.read"
  | "security.read"
  | "security.respond"
  | "ai.analyze";

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  platform_owner: ["*"],
  "tenant-admin": [
    "project.manage",
    "project.read",
    "server.manage",
    "server.read",
    "security.read",
    "security.respond",
    "ai.analyze",
  ],
  "security-analyst": [
    "security.read",
    "security.respond",
    "server.read",
    "project.read",
  ],
  "read-only": [
    "project.read",
    "server.read",
    "security.read",
  ],
};

export interface PersonaProfile {
  email: string;
  displayName: string;
  role: UserRole;
  companySlug: string;
  passwordPlaceholder: string;
  scopeDescription: string;
}

export const KNOWN_PERSONAS: Record<string, PersonaProfile> = {
  "alice@mock-acme.example": {
    email: "alice@mock-acme.example",
    displayName: "Alice Admin",
    role: "tenant-admin",
    companySlug: "mock-acme",
    passwordPlaceholder: "",
    scopeDescription: "Full management within mock-acme: projects, servers, decoys, alerts, telemetry",
  },
  "bob@mock-acme.example": {
    email: "bob@mock-acme.example",
    displayName: "Bob Analyst",
    role: "security-analyst",
    companySlug: "mock-acme",
    passwordPlaceholder: "",
    scopeDescription: "Operational security: alerts, agents, servers; mitigate incidents",
  },
  "carol@mock-acme.example": {
    email: "carol@mock-acme.example",
    displayName: "Carol Readonly",
    role: "read-only",
    companySlug: "mock-acme",
    passwordPlaceholder: "",
    scopeDescription: "Audit & monitoring: view dashboards, server inventory, and decoy status",
  },
  "analyst@acme.com": {
    email: "analyst@acme.com",
    displayName: "Alice Analyst",
    role: "security-analyst",
    companySlug: "mock-acme",
    passwordPlaceholder: "",
    scopeDescription: "Operational security: alerts, agents, servers; mitigate incidents",
  },
  "admin@cadoc.io": {
    email: "admin@cadoc.io",
    displayName: "Bootstrap Administrator",
    role: "platform_owner",
    companySlug: "global",
    passwordPlaceholder: "",
    scopeDescription: "Full cross-tenant control plane: provision clients, global admins, audit logs",
  },
};

// ─── Project Forensics API (Swagger) ───
export interface ForensicsQueryResult {
  columns: string[];
  rows: unknown[][];
}

export interface ForensicsQueryReq {
  sql: string;
}

export interface ForensicsChatMessage {
  role: "user" | "assistant";
  content: string;
  sql?: string | null;
  result?: ForensicsQueryResult | null;
}

export interface ForensicsChatReq {
  messages: ForensicsChatMessage[];
}

export interface ForensicsChatResponse {
  role?: string;
  content?: string;
  message?: string;
  response?: string;
  text?: string;
  detail?: string;
  [key: string]: unknown;
}
