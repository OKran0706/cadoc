import { test, expect, type Page } from "@playwright/test";

const base = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000";

async function signIn(page: Page, role: string) {
  await page.context().addCookies([{ name: "sentinel_token", value: "offline-test", url: base }]);
  await page.addInitScript((sessionRole) => {
    localStorage.setItem("sentinel_authenticated", "true");
    localStorage.setItem("auth_token", "offline-test");
    localStorage.setItem("sentinel_user", JSON.stringify({
      email: "operator@example.test",
      name: "Test Operator",
      role: sessionRole,
      companySlug: sessionRole === "platform_owner" ? "global" : "tenant-1",
      permissions: [],
    }));
  }, role);
  await page.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
}

test("tenant owner cannot see client organizations or disabled navigation", async ({ page }) => {
  await signIn(page, "tenant_owner");
  await page.goto(`${base}/admin`);
  await expect(page.getByRole("heading", { name: "Admin Control" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Client Organizations (Tenants)" })).toHaveCount(0);
  await expect(page.getByText("Kill Switch", { exact: true })).toHaveCount(0);
  await expect(page.locator('a[href="/automation"], a[href="/logs"]')).toHaveCount(0);
});

test("platform owner sees client organizations; removed pages return 404", async ({ page }) => {
  await signIn(page, "platform_owner");
  await page.goto(`${base}/admin`);
  await expect(page.getByRole("heading", { name: "Admin Control" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Client Organizations (Tenants)" })).toBeVisible();
  for (const route of ["automation", "logs"]) {
    const response = await page.request.get(`${base}/${route}`);
    expect(response.status()).toBe(404);
  }
});

test("dashboard keeps Forensics Vault without archive action and Detections page is unavailable", async ({ page }) => {
  await signIn(page, "tenant_owner");
  await page.goto(base);
  await expect(page.getByText("Forensics Vault", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Detection Risk Scoring" })).toBeVisible();
  await expect(page.getByRole("button", { name: "View Full Archive" })).toHaveCount(0);
  await expect(page.locator('a[href="/detections"]')).toHaveCount(0);
  const response = await page.request.get(`${base}/detections`);
  expect(response.status()).toBe(404);
});
