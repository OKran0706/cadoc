import { test, expect, type Page, type Route } from "@playwright/test";

const alerts = [
  { id: "alert-tampered", server_id: "server-1", event_type: "decoy_tampered", severity: "critical", details: { decoy_id: "decoy-1" }, detected_at: "2026-10-18T10:00:00Z" },
  { id: "alert-high", server_id: "server-1", event_type: "threat_detected", severity: "high", details: {}, detected_at: "2026-10-18T09:00:00Z" },
  { id: "alert-routine", server_id: "server-1", event_type: "SERVER_READDED", severity: "low", details: { action: "merged" }, detected_at: "2026-10-18T08:00:00Z", status: "OPEN" },
];

async function prepare(page: Page, role = "security-analyst", onQuarantine?: (route: Route) => Promise<void>) {
  await page.context().addCookies([{ name: "sentinel_token", value: "offline-test", url: "http://127.0.0.1:3000" }]);
  await page.addInitScript((sessionRole) => {
    localStorage.setItem("sentinel_authenticated", "true");
    localStorage.setItem("auth_token", "offline-test");
    localStorage.setItem("sentinel_user", JSON.stringify({ email: "analyst@example.test", name: "Test Analyst", role: sessionRole, permissions: sessionRole === "read-only" ? ["security.read"] : ["security.respond"] }));
  }, role);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/quarantine")) {
      if (onQuarantine) return onQuarantine(route);
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith("/mitigate")) return route.fulfill({ status: 204 });
    if (path.endsWith("/alerts/stream")) return route.abort();
    if (path === "/api/v1/dashboard/alerts") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: alerts, next_cursor: null, has_more: false }) });
    if (path === "/api/v1/decoys/decoy-1") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "decoy-1", server_id: "server-1", file_path: "/tmp/trap", decoy_type: "file", original_hash: "hash", status: "tampered", planted_at: "2026-10-18T08:00:00Z" }) });
    if (path === "/api/v1/decoys/") return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.goto("/events");
  await expect(page.getByRole("heading", { name: "decoy_tampered" })).toBeVisible();
};

test("tampered decoy quarantines with kill_parent; high alert does not kill parent; routine alert has no action", async ({ page }) => {
  let quarantineCalls = 0;
  const payloads: unknown[] = [];
  await prepare(page, "security-analyst", async (route) => {
    quarantineCalls++;
    payloads.push(route.request().postDataJSON());
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({ status: 204 });
  });
  await page.getByRole("heading", { name: "decoy_tampered" }).click();
  const quarantine = page.getByRole("button", { name: "Quarantine", exact: true });
  await quarantine.click();
  await expect(page.getByRole("button", { name: "Quarantining..." })).toBeDisabled();
  await expect(page.getByText("QUARANTINE REQUESTED", { exact: true })).toBeVisible();
  expect(quarantineCalls).toBe(1);
  expect(payloads[0]).toEqual({ kill_parent: true });
  await page.getByRole("heading", { name: "threat_detected" }).click();
  await page.getByRole("button", { name: "Quarantine", exact: true }).click();
  await expect(page.getByText("QUARANTINE REQUESTED", { exact: true })).toHaveCount(2);
  expect(payloads[1]).toEqual({ kill_parent: false });
  await page.getByRole("heading", { name: "SERVER_READDED" }).click();
  await expect(page.getByRole("button", { name: "Quarantine", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mitigate Threat" })).toHaveCount(0);
});

test("failed quarantine remains retryable", async ({ page }) => {
  let calls = 0;
  await prepare(page, "security-analyst", async (route) => {
    calls++;
    await route.fulfill({ status: 500, contentType: "application/json", body: '{"detail":"failed"}' });
  });
  await page.getByRole("heading", { name: "decoy_tampered" }).click();
  await page.getByRole("button", { name: "Quarantine", exact: true }).click();
  await expect(page.getByText("Quarantine failed. Please try again.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Quarantine", exact: true })).toBeEnabled();
  expect(calls).toBe(1);
});

test("read-only user cannot trigger quarantine", async ({ page }) => {
  let calls = 0;
  await prepare(page, "read-only", async (route) => {
    calls++;
    await route.fulfill({ status: 204 });
  });
  await page.getByRole("heading", { name: "decoy_tampered" }).click();
  await expect(page.getByRole("button", { name: "Quarantine", exact: true })).toBeDisabled();
  expect(calls).toBe(0);
});
