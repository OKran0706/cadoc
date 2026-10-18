import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-RBAC-P3-1: src/app/login/page.tsx must provide enterprise credential inputs
test("INV-RBAC-P3-1: src/app/login/page.tsx must provide standard enterprise credential inputs", () => {
  const content = fs.readFileSync("src/app/login/page.tsx", "utf8");
  assert.ok(content.includes('id="email"'), "Login page must have email input");
  assert.ok(content.includes('id="password"'), "Login page must have password input");
  assert.ok(content.includes('id="companySlug"'), "Login page must have companySlug input");
});

// INV-RBAC-P3-2: src/app/login/page.tsx must submit authentication payload via login()
test("INV-RBAC-P3-2: src/app/login/page.tsx must submit credentials via login()", () => {
  const content = fs.readFileSync("src/app/login/page.tsx", "utf8");
  assert.ok(
    content.includes("await login(email, password,"),
    "Login page must submit credentials to login service"
  );
  assert.ok(
    content.includes("handleSubmit"),
    "Login page must have form submit handler"
  );
});

// INV-RBAC-P3-3: src/app/login/page.tsx must not contain hardcoded persona switcher shortcuts
test("INV-RBAC-P3-3: src/app/login/page.tsx must not contain hardcoded persona selector cards", () => {
  const content = fs.readFileSync("src/app/login/page.tsx", "utf8");
  assert.ok(
    !content.includes("Select Active Persona"),
    "Login page must not display persona selector cards"
  );
  assert.ok(
    !content.includes("handleInstantPersonaLogin"),
    "Login page must not expose instant persona login shortcuts"
  );
});

// INV-RBAC-P3-4: src/app/login/page.tsx must not contain SSO integrations (Google / Active Directory)
test("INV-RBAC-P3-4: src/app/login/page.tsx must not contain SSO integrations", () => {
  const content = fs.readFileSync("src/app/login/page.tsx", "utf8");
  assert.ok(
    !content.includes("Active Directory"),
    "Login page must not display Active Directory SSO"
  );
  assert.ok(
    !content.includes("or SSO Single Sign-On"),
    "Login page must not display SSO Single Sign-On divider"
  );
  assert.ok(
    !content.includes("Google\n            </button>"),
    "Login page must not display Google SSO button"
  );
});

// INV-RBAC-P3-5: src/app/login/page.tsx must not contain hardcoded default mock-acme tenant
test("INV-RBAC-P3-5: src/app/login/page.tsx must not hardcode default mock-acme tenant", () => {
  const content = fs.readFileSync("src/app/login/page.tsx", "utf8");
  assert.ok(
    !content.includes("mock-acme"),
    "Login page must not contain default mock-acme tenant name, placeholder, or fallback"
  );
});
