import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "VarianHMIS2026!";

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill("admin@fam.test");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId("screen-admin")).toBeVisible();
}

test("admin workspace loads every section and filters audit events", async ({ page }) => {
  await signInAsAdmin(page);
  await expect(page.getByTestId("admin-active-facility")).toBeVisible();

  const sections = [
    { tab: "setup", panel: "admin-setup-list" },
    { tab: "staff", panel: "admin-staff-list" },
    { tab: "catalogs", panel: "admin-catalog-list" },
    { tab: "prices", panel: "admin-price-list-list" },
    { tab: "audit", panel: "admin-audit-filter-panel" },
  ] as const;

  for (const section of sections) {
    const tab = page.getByTestId(`admin-tab-${section.tab}`);
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(section.panel)).toBeVisible();
  }

  const code = `E2E${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const commandResponse = await page.request.post("/api/admin/commands", {
    data: {
      command: "createBranch",
      input: {
        code,
        name: "E2E Audit Branch",
        idempotencyKey: randomUUID(),
      },
    },
  });
  expect(commandResponse.status()).toBe(201);
  const commandBody = (await commandResponse.json()) as {
    result: { branchId: string; code: string };
  };
  expect(commandBody.result.code).toBe(code);
  const branchId = commandBody.result.branchId;

  const auditResponse = await page.request.get("/api/admin/audit", {
    params: {
      action: "admin.branch.create",
      entity: "branches",
      entityId: branchId,
      limit: "10",
    },
  });
  expect(auditResponse.status()).toBe(200);
  const auditBody = (await auditResponse.json()) as {
    events: Array<{ action: string; entity_id: string; details: { code?: string } }>;
  };
  expect(auditBody.events).toHaveLength(1);
  expect(auditBody.events[0]).toMatchObject({
    action: "admin.branch.create",
    entity_id: branchId,
  });
  expect(auditBody.events[0].details.code).toBe(code);

  await page.getByTestId("admin-tab-audit").click();
  await page.getByTestId("admin-field-action").fill("admin.branch.create");
  await page.getByTestId("admin-field-entityId").fill(branchId);
  await page.getByTestId("admin-audit-filter-submit").click();

  await expect(page.getByTestId("admin-audit-rows")).toContainText("admin.branch.create");
  await expect(page.getByTestId("admin-audit-rows")).toContainText(branchId);
  await expect(page.getByTestId("admin-audit-rows")).toContainText(code);
});
