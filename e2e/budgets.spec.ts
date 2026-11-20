import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "VarianHMIS2026!";

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("[data-testid^='screen-']").first()).toBeVisible();
}

async function apiPost<T>(
  page: Page,
  url: string,
  command: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const response = await page.request.post(url, {
    data: {
      command,
      input: { idempotencyKey: randomUUID(), ...input },
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { result: T };
  return body.result;
}

interface Account {
  id: string;
  code: string;
}

function uniqueDate(): string {
  const seed = randomUUID().replace(/-/g, "");
  const year = 2300 + (Number.parseInt(seed.slice(0, 4), 16) % 100);
  const month = 1 + (Number.parseInt(seed.slice(4, 6), 16) % 12);
  const day = 1 + (Number.parseInt(seed.slice(6, 8), 16) % 27);
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

test("accountant plans, approves and enforces an expense budget", async ({ page }) => {
  await signIn(page, "accountant@fam.test");

  const financeResponse = await page.request.get("/api/finance");
  expect(financeResponse.status()).toBe(200);
  const finance = (await financeResponse.json()) as { accounts: Account[] };
  const cash = finance.accounts.find((account) => account.code === "1000");
  const supplies = finance.accounts.find((account) => account.code === "5000");
  expect(cash && supplies).toBeTruthy();

  const date = uniqueDate();
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const period = await apiPost<{ periodId: string }>(page, "/api/finance", "openFiscalPeriod", {
    name: `E2E budget ${suffix}`,
    startDate: date,
    endDate: date,
  });

  await page.goto("/finance/budgets");
  await expect(page.getByTestId("screen-budgets")).toBeVisible();
  await expect(page.getByTestId("budgets-register-panel")).toBeVisible();

  const budgetCode = `E2EB${suffix}`;
  await page.getByTestId("budgets-new-button").click();
  const form = page.getByTestId("budgets-form");
  await form.getByLabel("Budget code").fill(budgetCode);
  await form.getByLabel("Budget name").fill(`E2E budget plan ${suffix}`);
  await form.getByLabel("Budget fiscal period").selectOption(period.periodId);
  await form.getByLabel("Budget line 1 account").selectOption(supplies!.id);
  await form.getByLabel("Budget line 1 amount").fill("1000.00");
  await form.getByRole("button", { name: "Create draft" }).click();

  await expect(page.getByTestId(`budgets-row-${budgetCode}`)).toContainText("Draft");
  await expect(page.getByTestId("budgets-detail-status")).toContainText("Draft");

  await page.getByTestId("budgets-submit").click();
  await expect(page.getByTestId("budgets-detail-status")).toContainText("Awaiting approval");

  await page.getByTestId("budgets-approve").click();
  await expect(page.getByTestId("budgets-detail-status")).toContainText("Approved");
  await expect(page.getByTestId("budgets-detail-status")).toContainText("Enforced");

  await apiPost(page, "/api/finance", "postManualJournal", {
    entryDate: date,
    description: `E2E budget spend ${suffix}`,
    lines: [
      { accountId: supplies!.id, debit: "600.00", credit: 0 },
      { accountId: cash!.id, debit: 0, credit: "600.00" },
    ],
  });

  await page.getByTestId("budgets-refresh").click();
  await expect(page.getByTestId("budgets-detail-actual")).toContainText("600.00");
  await expect(page.getByTestId("budgets-detail-variance")).toContainText("400.00");
  await expect(page.getByTestId(`budgets-detail-line-${supplies!.code}`)).toContainText("600.00");

  const overspend = await page.request.post("/api/finance", {
    data: {
      command: "postManualJournal",
      input: {
        idempotencyKey: randomUUID(),
        entryDate: date,
        description: `E2E budget overspend ${suffix}`,
        lines: [
          { accountId: supplies!.id, debit: "700.00", credit: 0 },
          { accountId: cash!.id, debit: 0, credit: "700.00" },
        ],
      },
    },
  });
  expect(overspend.status()).toBe(400);
  const overspendBody = (await overspend.json()) as { error?: string };
  expect(overspendBody.error).toMatch(/exceed the approved budget/i);

  const filtered = await page.request.get(
    `/api/finance/budgets?periodId=${period.periodId}&status=approved`,
  );
  expect(filtered.status()).toBe(200);
  const filteredBody = (await filtered.json()) as {
    budgets: Array<{ code: string; actual: string; variance: string }>;
  };
  const row = filteredBody.budgets.find((item) => item.code === budgetCode);
  expect(row).toBeTruthy();
  expect(row!.actual).toBe("600.00");
  expect(row!.variance).toBe("400.00");
  expect(row!.variance.startsWith("-")).toBe(false);
});

test("auditor reads budgets but cannot write", async ({ page }) => {
  await signIn(page, "auditor@fam.test");
  await page.goto("/finance/budgets");
  await expect(page.getByTestId("screen-budgets")).toBeVisible();
  await expect(page.getByTestId("budgets-new-button")).toHaveCount(0);

  const read = await page.request.get("/api/finance/budgets");
  expect(read.status()).toBe(200);

  const write = await page.request.post("/api/finance/budgets", {
    data: {
      command: "createBudget",
      input: { idempotencyKey: randomUUID(), code: "DENIED", name: "Denied" },
    },
  });
  expect(write.status()).toBe(403);
});

test("cashier cannot read or write budgets", async ({ page }) => {
  await signIn(page, "cashier@fam.test");

  const read = await page.request.get("/api/finance/budgets");
  expect(read.status()).toBe(403);
  const write = await page.request.post("/api/finance/budgets", {
    data: {
      command: "createBudget",
      input: { idempotencyKey: randomUUID(), code: "DENIED", name: "Denied" },
    },
  });
  expect(write.status()).toBe(403);
});
