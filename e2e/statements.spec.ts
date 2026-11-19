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
  command: string,
  input: Record<string, unknown>,
): Promise<T> {
  const response = await page.request.post("/api/finance", {
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
  name: string;
}

function uniqueDate(): { date: string; year: number } {
  const seed = randomUUID().replace(/-/g, "");
  const year = 2100 + (Number.parseInt(seed.slice(0, 4), 16) % 100);
  const month = 1 + (Number.parseInt(seed.slice(4, 6), 16) % 12);
  const day = 1 + (Number.parseInt(seed.slice(6, 8), 16) % 27);
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return { date: `${year}-${pad(month)}-${pad(day)}`, year };
}

function parseMoney(text: string): number {
  return Number(text.replace(/[^0-9.-]/g, ""));
}

test("financial statements report posted journals and guard finance roles", async ({ page }) => {
  await signIn(page, "accountant@fam.test");

  const financeResponse = await page.request.get("/api/finance");
  expect(financeResponse.status()).toBe(200);
  const finance = (await financeResponse.json()) as { accounts: Account[] };
  const cash = finance.accounts.find((account) => account.code === "1000");
  const revenue = finance.accounts.find((account) => account.code === "4000");
  const supplies = finance.accounts.find((account) => account.code === "5000");
  expect(cash && revenue && supplies).toBeTruthy();

  const { date } = uniqueDate();
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

  const baselineResponse = await page.request.get(
    `/api/finance/statements?from=${date}&to=${date}`,
  );
  expect(baselineResponse.status()).toBe(200);
  const baseline = (await baselineResponse.json()) as {
    statements: { balanceSheet: { totalAssets: string } };
  };
  const baselineAssets = parseMoney(baseline.statements.balanceSheet.totalAssets);

  await apiPost(page, "postManualJournal", {
    entryDate: date,
    description: `E2E statement revenue ${suffix}`,
    lines: [
      { accountId: cash!.id, debit: "2000.00", credit: 0 },
      { accountId: revenue!.id, debit: 0, credit: "2000.00" },
    ],
  });
  await apiPost(page, "postManualJournal", {
    entryDate: date,
    description: `E2E statement expense ${suffix}`,
    lines: [
      { accountId: supplies!.id, debit: "300.00", credit: 0 },
      { accountId: cash!.id, debit: 0, credit: "300.00" },
    ],
  });

  await page.goto("/finance/statements");
  await expect(page.getByTestId("screen-statements")).toBeVisible();
  await page.getByLabel("Statement from date").fill(date);
  await page.getByLabel("Statement to date").fill(date);
  await page.getByTestId("statements-refresh").click();

  await expect(page.getByTestId("statements-kpi-net-income")).toContainText("1,700.00");
  await expect
    .poll(async () => parseMoney(await page.getByTestId("statements-total-assets").innerText()))
    .toBe(baselineAssets + 1700);
  await expect(page.getByTestId("statements-balance-status")).toContainText("Balanced");

  await page.getByTestId("statements-tab-income").click();
  await expect(page.getByTestId("statements-income-revenue-table")).toContainText("4000");
  await expect(page.getByTestId("statements-income-expenses-table")).toContainText("5000");
  await expect(page.getByTestId("statements-net-income")).toContainText("1,700.00");

  await page.getByTestId("statements-tab-cash").click();
  await expect(page.getByTestId("statements-cash-movement")).toContainText("1,700.00");
  await expect(page.getByTestId("statements-cash-table-operating")).toContainText(
    "E2E statement revenue",
  );

  const centerCode = `ST${suffix}`;
  const center = await apiPost<{ costCenterId: string }>(page, "createCostCenter", {
    code: centerCode,
    name: `E2E statement centre ${suffix}`,
  });
  await apiPost(page, "postManualJournal", {
    entryDate: date,
    description: `E2E tagged journal ${suffix}`,
    lines: [
      {
        accountId: cash!.id,
        debit: "111.00",
        credit: 0,
        costCenterId: center.costCenterId,
      },
      {
        accountId: revenue!.id,
        debit: 0,
        credit: "111.00",
        costCenterId: center.costCenterId,
      },
    ],
  });

  await page.reload();
  await expect(page.getByTestId("screen-statements")).toBeVisible();
  await page.getByLabel("Statement from date").fill(date);
  await page.getByLabel("Statement to date").fill(date);
  await page.getByLabel("Statement dimension").selectOption(`cost:${center.costCenterId}`);
  await page.getByTestId("statements-refresh").click();

  await expect(page.getByTestId("statements-kpi-net-income")).toContainText("111.00");
  await expect(page.getByTestId("statements-dimension-note")).toContainText(centerCode);

  await signIn(page, "auditor@fam.test");
  const allowed = await page.request.get("/api/finance/statements");
  expect(allowed.status()).toBe(200);

  await signIn(page, "cashier@fam.test");
  const denied = await page.request.get("/api/finance/statements");
  expect(denied.status()).toBe(403);
});
