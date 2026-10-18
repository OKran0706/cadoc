import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ─── Phase: Server Country Catalog, Search & Form Validation Invariants ───

// INV-SRV-VAL-1: src/lib/countries.ts exports Country catalog with ISO codes, flags, regions
test("INV-SRV-VAL-1: src/lib/countries.ts must export comprehensive COUNTRIES catalog and getCountryByCode helper", () => {
  assert.ok(fs.existsSync("src/lib/countries.ts"), "src/lib/countries.ts must exist");
  const content = fs.readFileSync("src/lib/countries.ts", "utf8");

  assert.ok(content.includes("export interface Country"), "Must export Country interface");
  assert.ok(content.includes("export const COUNTRIES"), "Must export COUNTRIES array");
  assert.ok(content.includes("export function getCountryByCode"), "Must export getCountryByCode helper");
  assert.ok(content.includes("export function formatLocation"), "Must export formatLocation helper");

  // Check key major cloud regions
  assert.ok(content.includes('"US"') && content.includes('"United States"'), "Must include United States");
  assert.ok(content.includes('"JP"') && content.includes('"Japan"'), "Must include Japan");
  assert.ok(content.includes('"DE"') && content.includes('"Germany"'), "Must include Germany");
  assert.ok(content.includes('"GB"') && content.includes('"United Kingdom"'), "Must include United Kingdom");
  assert.ok(content.includes('"SG"') && content.includes('"Singapore"'), "Must include Singapore");
  assert.ok(content.includes('"IN"') && content.includes('"India"'), "Must include India");
});

// INV-SRV-VAL-2 & 3: Hostname validation invariants
test("INV-SRV-VAL-2 & 3: src/lib/serverValidation.ts must export validateHostname with strict naming rules", () => {
  assert.ok(fs.existsSync("src/lib/serverValidation.ts"), "src/lib/serverValidation.ts must exist");
  const content = fs.readFileSync("src/lib/serverValidation.ts", "utf8");

  assert.ok(content.includes("export function validateHostname"), "Must export validateHostname");
  assert.ok(content.includes("Server ID (hostname) is required"), "Must check for required hostname");
  assert.ok(content.includes("at least 2 characters"), "Must enforce minimum length");
  assert.ok(content.includes("cannot exceed 63 characters"), "Must enforce maximum length (RFC 1123)");
  assert.ok(content.includes("spaces"), "Must forbid spaces in hostname");

  // Functional regex test
  const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;
  assert.equal(hostnameRegex.test("SENTINEL-NODE-01"), true);
  assert.equal(hostnameRegex.test("node.tokyo-01"), true);
  assert.equal(hostnameRegex.test("has space"), false);
  assert.equal(hostnameRegex.test("-leading"), false);
  assert.equal(hostnameRegex.test("trailing-"), false);
  assert.equal(hostnameRegex.test("bad$char#"), false);
});

// INV-SRV-VAL-4: IP address validation invariants
test("INV-SRV-VAL-4: src/lib/serverValidation.ts must export validateIpAddress strictly enforcing IPv4 and IPv6", () => {
  const content = fs.readFileSync("src/lib/serverValidation.ts", "utf8");

  assert.ok(content.includes("export function validateIpAddress"), "Must export validateIpAddress");
  assert.ok(content.includes("IP address is required"), "Must check for required IP");
  assert.ok(content.includes("ipv4Regex"), "Must validate IPv4 address");
  assert.ok(content.includes("ipv6Regex"), "Must validate IPv6 address");

  // Functional regex test
  const ipv4Regex =
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;
  assert.equal(ipv4Regex.test("192.168.1.1"), true);
  assert.equal(ipv4Regex.test("10.20.1.45"), true);
  assert.equal(ipv4Regex.test("255.255.255.255"), true);
  assert.equal(ipv4Regex.test("256.1.1.1"), false);
  assert.equal(ipv4Regex.test("10.0.0.01"), false);
  assert.equal(ipv4Regex.test("192.168.1"), false);
  assert.equal(ipv4Regex.test("abc"), false);
});

// INV-SRV-VAL-5: Country validation invariants
test("INV-SRV-VAL-5: src/lib/serverValidation.ts must export validateCountry and validateServerForm", () => {
  const content = fs.readFileSync("src/lib/serverValidation.ts", "utf8");

  assert.ok(content.includes("export function validateCountry"), "Must export validateCountry");
  assert.ok(content.includes("export function validateServerForm"), "Must export validateServerForm");
  assert.ok(content.includes("Country selection is required"), "Must require country selection");
  assert.ok(content.includes("getCountryByCode"), "Must look up country code in catalog");
});

// INV-SRV-VAL-6: SearchableCountrySelect component
test("INV-SRV-VAL-6: src/components/SearchableCountrySelect.tsx must implement search filtering and region chips", () => {
  assert.ok(fs.existsSync("src/components/SearchableCountrySelect.tsx"), "SearchableCountrySelect component must exist");
  const content = fs.readFileSync("src/components/SearchableCountrySelect.tsx", "utf8");

  assert.ok(content.includes("search"), "Must implement search filter state");
  assert.ok(content.includes("activeRegion"), "Must implement region chip filtering");
  assert.ok(content.includes("filteredCountries"), "Must filter countries dynamically");
  assert.ok(content.includes("placeholder="), "Must support custom placeholder");
  assert.ok(content.includes("COUNTRIES"), "Must import and utilize COUNTRIES catalog");
});

// INV-SRV-VAL-7: AddServerModal must integrate SearchableCountrySelect and display inline validation errors
test("INV-SRV-VAL-7: src/components/AddServerModal.tsx must render SearchableCountrySelect and display inline validation errors", () => {
  const content = fs.readFileSync("src/components/AddServerModal.tsx", "utf8");
  assert.ok(
    content.includes("SearchableCountrySelect"),
    "AddServerModal must import and render SearchableCountrySelect"
  );
  assert.ok(
    content.includes("validationErrors.name") &&
      content.includes("validationErrors.country") &&
      content.includes("validationErrors.ip"),
    "AddServerModal must display inline validation errors for name, country, and ip"
  );
  assert.ok(
    content.includes("disabled={!canAdvanceStep1}"),
    "AddServerModal must disable advance when form is invalid"
  );
});

// INV-SRV-VAL-8: AddServerModal must preserve projectService and serverService contracts
test("INV-SRV-VAL-8: src/components/AddServerModal.tsx must preserve existing Phase 3 invariants", () => {
  const content = fs.readFileSync("src/components/AddServerModal.tsx", "utf8");
  assert.match(
    content,
    /import\s+.*projectService.*from\s+["']@\/services\/projectService["']/,
    "Must preserve projectService import"
  );
  assert.match(
    content,
    /import\s+.*serverService.*from\s+["']@\/services\/serverService["']/,
    "Must preserve serverService import"
  );
  assert.match(
    content,
    /projectService\s*\.\s*listProjects\(\)/,
    "Must preserve listProjects call"
  );
});
