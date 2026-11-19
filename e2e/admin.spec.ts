import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "VarianHMIS2026!";
const SECTIONS = [
  { tab: "setup", panel: "admin-setup-list" },
  { tab: "staff", panel: "admin-staff-list" },
  { tab: "catalogs", panel: "admin-catalog-list" },
  { tab: "prices", panel: "admin-price-list-list" },
  { tab: "audit", panel: "admin-audit-filter-panel" },
  { tab: "sync", panel: "admin-sync-status-panel" },
] as const;

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function signInAsAdmin(page: Page) {
  await signIn(page, "admin@fam.test");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId("screen-admin")).toBeVisible();
}

test("admin sections are deep-linked, survive reload and restore with browser back", async ({ page }) => {
  await signInAsAdmin(page);
  await expect(page.getByTestId("admin-active-facility")).toBeVisible();

  for (const section of SECTIONS) {
    const tab = page.getByTestId(`admin-tab-${section.tab}`);
    const url = new RegExp(`/admin/${section.tab}$`);
    await tab.click();
    // The first click can land before the client navigation handler is attached.
    try {
      await expect(page).toHaveURL(url, { timeout: 3_000 });
    } catch {
      await tab.click();
      await expect(page).toHaveURL(url);
    }
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(section.panel)).toBeVisible();
  }

  await page.reload();
  await expect(page).toHaveURL(/\/admin\/sync$/);
  await expect(page.getByTestId("admin-sync-status-panel")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/audit$/);
  await expect(page.getByTestId("admin-audit-filter-panel")).toBeVisible();
});

test("admin creates setup data from the form and filters the resulting audit event", async ({ page }) => {
  await signInAsAdmin(page);
  await expect(page).toHaveURL(/\/admin$/);

  const code = `E2E${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  await page.getByTestId("admin-field-code").fill(code);
  await page.getByTestId("admin-field-name").fill("E2E UI Branch");
  await page.getByTestId("admin-setup-form-submit").click();
  await expect(page.getByTestId("admin-setup-rows-branch")).toContainText(code);

  const overviewResponse = await page.request.get("/api/admin/overview");
  expect(overviewResponse.status()).toBe(200);
  const overview = (await overviewResponse.json()) as {
    sections: string[];
    setup: { branches: Array<{ id: string; code: string }> };
  };
  expect(overview.sections).toContain("setup");
  const branchId = overview.setup.branches.find((branch) => branch.code === code)?.id;
  expect(branchId).toBeTruthy();

  await page.getByTestId("admin-tab-audit").click();
  await expect(page).toHaveURL(/\/admin\/audit$/);
  await page.getByTestId("admin-field-action").fill("admin.branch.create");
  await page.getByTestId("admin-field-entityId").fill(branchId!);
  await page.getByTestId("admin-audit-filter-submit").click();

  await expect(page.getByTestId("admin-audit-rows")).toContainText("admin.branch.create");
  await expect(page.getByTestId("admin-audit-rows")).toContainText(branchId!);
  await expect(page.getByTestId("admin-audit-rows")).toContainText(code);
});

test("section-scoped administrators are limited in both the UI and the API", async ({ browser, baseURL }) => {
  const adminContext = await browser.newContext({ baseURL });
  const adminPage = await adminContext.newPage();
  await signInAsAdmin(adminPage);

  const overviewResponse = await adminPage.request.get("/api/admin/overview");
  const overview = (await overviewResponse.json()) as { facilityId: string };
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const email = `restricted-${suffix.toLowerCase()}@fam.test`;
  const password = "RestrictedAdmin2026!";

  const created = await adminPage.request.post("/api/admin/commands", {
    data: {
      command: "createStaff",
      input: {
        idempotencyKey: randomUUID(),
        name: "Section Limited Admin",
        email,
        password,
        staffNumber: `E2ER${suffix}`,
        scopes: [{ role: "admin", facilityId: overview.facilityId, branchId: null }],
      },
    },
  });
  expect(created.status()).toBe(201);
  const createdBody = (await created.json()) as { result: { userId: string } };

  const granted = await adminPage.request.post("/api/admin/commands", {
    data: {
      command: "setAdminSectionAccess",
      input: {
        idempotencyKey: randomUUID(),
        userId: createdBody.result.userId,
        sections: ["audit"],
      },
    },
  });
  expect(granted.status()).toBe(201);
  await adminContext.close();

  const restrictedContext = await browser.newContext({ baseURL });
  const restricted = await restrictedContext.newPage();
  await signIn(restricted, email, password);

  await expect(restricted).toHaveURL(/\/admin\/audit$/);
  await expect(restricted.getByTestId("admin-audit-filter-panel")).toBeVisible();
  await expect(restricted.getByTestId("admin-tab-audit")).toBeVisible();
  for (const section of SECTIONS.filter((item) => item.tab !== "audit")) {
    await expect(restricted.getByTestId(`admin-tab-${section.tab}`)).toHaveCount(0);
  }

  const restrictedOverview = await restricted.request.get("/api/admin/overview");
  expect(restrictedOverview.status()).toBe(200);
  const restrictedBody = (await restrictedOverview.json()) as {
    sections: string[];
    staff: unknown[];
    prices: unknown[];
  };
  expect(restrictedBody.sections).toEqual(["audit"]);
  expect(restrictedBody.staff).toEqual([]);
  expect(restrictedBody.prices).toEqual([]);

  for (const path of ["/api/admin/staff", "/api/admin/sync", "/api/admin/overview?section=prices"]) {
    const response = await restricted.request.get(path);
    // The overview is allowed but contains only the granted section's data.
    expect(response.status(), path).toBe(path.startsWith("/api/admin/overview") ? 200 : 403);
  }
  const auditResponse = await restricted.request.get("/api/admin/audit?limit=5");
  expect(auditResponse.status()).toBe(200);
  const deniedMutation = await restricted.request.post("/api/admin/commands", {
    data: {
      command: "setPriceListActive",
      input: { id: randomUUID(), active: false },
    },
  });
  expect(deniedMutation.status()).toBe(403);

  await restricted.goto("/admin/prices");
  await expect(restricted.getByTestId("screen-forbidden")).toBeVisible();
  await restricted.goto("/admin/staff");
  await expect(restricted.getByTestId("screen-forbidden")).toBeVisible();

  await restrictedContext.close();
});
