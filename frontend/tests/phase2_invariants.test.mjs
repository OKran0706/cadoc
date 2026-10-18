import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-P2-1: Types check for new EC2 schemas
test("INV-P2-1: src/lib/types.ts must define Project, Server, AgentProof schemas and company_slug in LoginRequest", () => {
  const typesContent = fs.readFileSync("src/lib/types.ts", "utf8");
  
  // LoginRequest with company_slug
  assert.match(typesContent, /company_slug\??:\s*string/, "LoginRequest must support company_slug");

  // Project schemas
  assert.match(typesContent, /export interface ProjectCreate/, "Must export ProjectCreate");
  assert.match(typesContent, /export interface ProjectResponse/, "Must export ProjectResponse");
  
  // Server schemas
  assert.match(typesContent, /export interface ServerCreate/, "Must export ServerCreate");
  assert.match(typesContent, /export interface ServerResponse/, "Must export ServerResponse");

  // Agent with capabilities_proof schema
  assert.match(typesContent, /capabilities_proof/, "Agent schema must include capabilities_proof");
});

// INV-P2-2: projectService definition
test("INV-P2-2: src/services/projectService.ts must export listProjects and createProject", () => {
  assert.ok(fs.existsSync("src/services/projectService.ts"), "projectService.ts must exist");
  const content = fs.readFileSync("src/services/projectService.ts", "utf8");
  assert.match(content, /listProjects\s*:\s*\(/, "Must export listProjects");
  assert.match(content, /createProject\s*:\s*\(/, "Must export createProject");
  assert.match(content, /\/api\/v1\/projects\//, "Must target /api/v1/projects/");
});

// INV-P2-3: serverService definition
test("INV-P2-3: src/services/serverService.ts must export listServers and createServer", () => {
  assert.ok(fs.existsSync("src/services/serverService.ts"), "serverService.ts must exist");
  const content = fs.readFileSync("src/services/serverService.ts", "utf8");
  assert.match(content, /listServers\s*:\s*\(/, "Must export listServers");
  assert.match(content, /createServer\s*:\s*\(/, "Must export createServer");
  assert.match(content, /\/api\/v1\/servers\//, "Must target /api/v1/servers/");
});

// INV-P2-4: agentService extended with direct agent registry endpoint
test("INV-P2-4: src/services/agentService.ts must include direct /api/v1/agents/ endpoint", () => {
  const content = fs.readFileSync("src/services/agentService.ts", "utf8");
  assert.match(content, /\/api\/v1\/agents\//, "Must target direct /api/v1/agents/ endpoint");
  assert.match(content, /listRegistryAgents|listAgents/, "Must expose list method for agent registry");
});

// INV-P2-5: onboardingService definition
test("INV-P2-5: src/services/onboardingService.ts must export provisionTenant and brokeredJoin", () => {
  assert.ok(fs.existsSync("src/services/onboardingService.ts"), "onboardingService.ts must exist");
  const content = fs.readFileSync("src/services/onboardingService.ts", "utf8");
  assert.match(content, /provisionTenant\s*:\s*\(/, "Must export provisionTenant");
  assert.match(content, /brokeredJoin\s*:\s*\(/, "Must export brokeredJoin");
  assert.match(content, /\/api\/v1\/onboarding\/provision/, "Must target /api/v1/onboarding/provision");
  assert.match(content, /\/api\/v1\/bootstrap\/join/, "Must target /api/v1/bootstrap/join");
});

// INV-P2-6: authService supports company_slug parameter
test("INV-P2-6: src/services/authService.ts loginUser must accept companySlug parameter", () => {
  const content = fs.readFileSync("src/services/authService.ts", "utf8");
  assert.match(content, /companySlug\??:\s*string/, "loginUser must accept optional companySlug");
});
