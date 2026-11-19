import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "VarianHMIS2026!";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/finance$/);
  await expect(page.getByTestId("screen-finance")).toBeVisible();
}

function code(label: string): string {
  return `${label}${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

async function createLedgerAccount(
  page: Page,
  type: "asset" | "revenue",
  label: string,
): Promise<{ accountId: string; code: string }> {
  const accountCode = code("E2E");
  const response = await page.request.post("/api/finance", {
    data: {
      command: "createLedgerAccount",
      input: { idempotencyKey: randomUUID(), code: accountCode, name: `${label} ${accountCode}`, type },
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { result: { accountId: string; code: string } };
  return body.result;
}

test("accountant manages the chart of accounts and cost centres", async ({ page }) => {
  await signIn(page, "accountant@fam.test");
  await expect(page.getByTestId("finance-kpi-cash")).toBeVisible();
  await expect(page.getByTestId("finance-kpi-ledger")).toBeVisible();

  await page.getByTestId("finance-tab-accounts").click();
  await expect(page.getByTestId("finance-accounts-panel")).toBeVisible();

  const accountCode = code("E2EA");
  await page.getByRole("button", { name: "New account" }).click();
  const accountForm = page.getByTestId("finance-account-form");
  await accountForm.getByLabel("Code").fill(accountCode);
  await accountForm.getByLabel("Name").fill("E2E clinic asset");
  await accountForm.getByLabel("Type").selectOption("asset");
  await accountForm.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId(`finance-account-${accountCode}`)).toContainText("E2E clinic asset");

  const centerCode = code("E2EC");
  await page.getByRole("button", { name: "New cost centre" }).click();
  const centerForm = page.getByTestId("finance-cost-center-form");
  await centerForm.getByLabel("Code").fill(centerCode);
  await centerForm.getByLabel("Name").fill("E2E branch");
  await centerForm.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("finance-cost-centers-table")).toContainText(centerCode);
});

test("auditor reads finance data but cannot write", async ({ page }) => {
  await signIn(page, "auditor@fam.test");
  await page.getByTestId("finance-tab-accounts").click();
  await expect(page.getByTestId("finance-accounts-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "New account" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Post journal" })).toHaveCount(0);

  const read = await page.request.get("/api/finance");
  expect(read.status()).toBe(200);

  const write = await page.request.post("/api/finance", {
    data: {
      command: "createLedgerAccount",
      input: { idempotencyKey: randomUUID(), code: code("DENY"), name: "Denied", type: "asset" },
    },
  });
  expect(write.status()).toBe(403);
});

test("accountant posts, reports and reverses a balanced journal", async ({ page }) => {
  await signIn(page, "accountant@fam.test");
  const debit = await createLedgerAccount(page, "asset", "E2E debit");
  const credit = await createLedgerAccount(page, "revenue", "E2E credit");
  await page.goto("/finance");
  await expect(page.getByTestId("finance-journals-panel")).toBeVisible();

  const description = `E2E journal ${randomUUID().slice(0, 8)}`;
  await page.getByRole("button", { name: "Post journal" }).first().click();
  const journalForm = page.getByTestId("finance-journal-form");
  await journalForm.getByLabel("Description").fill(description);
  await journalForm.getByLabel("Journal line account").nth(0).selectOption(debit.accountId);
  await journalForm.getByLabel("Journal line account").nth(1).selectOption(credit.accountId);
  await journalForm.getByLabel("Debit amount").nth(0).fill("1250.00");
  await journalForm.getByLabel("Credit amount").nth(1).fill("1250.00");
  await expect(journalForm.getByText("Balanced")).toBeVisible();
  await journalForm.getByRole("button", { name: "Post journal" }).click();
  await expect(page.getByTestId("finance-journals-table")).toContainText(description);

  await page.getByTestId("finance-tab-trial").click();
  await expect(page.getByTestId("finance-trial-table")).toContainText(debit.code);
  await expect(page.getByTestId("finance-trial-table")).toContainText(credit.code);

  await page.getByTestId("finance-tab-ledger").click();
  await page.getByTestId("finance-ledger-account-select").selectOption(debit.accountId);
  await expect(page.getByTestId("finance-ledger-table")).toContainText(description);

  await page.getByTestId("finance-tab-journals").click();
  const row = page.getByTestId("finance-journals-table").locator("tr", { hasText: description });
  await row.getByRole("button", { name: "Reverse" }).click();
  const reversalForm = page.getByTestId("finance-reversal-form");
  await reversalForm.getByLabel("Reason").fill("E2E correction");
  await reversalForm.getByRole("button", { name: "Post reversal" }).click();
  await expect(page.getByTestId("finance-journals-table")).toContainText("reversed");
});

test("finance officer records bank activity and completes a reconciliation", async ({ page }) => {
  await signIn(page, "finance@fam.test");
  const ledger = await createLedgerAccount(page, "asset", "E2E bank ledger");
  await page.goto("/finance");
  await page.getByTestId("finance-tab-banking").click();
  await expect(page.getByTestId("finance-bank-accounts-panel")).toBeVisible();

  const bankName = `E2E Bank ${randomUUID().slice(0, 8)}`;
  await page.getByRole("button", { name: "New account" }).click();
  const accountForm = page.getByTestId("finance-bank-account-form");
  await accountForm.getByLabel("Account name").fill(bankName);
  await accountForm.getByLabel(/Ledger account/).selectOption(ledger.accountId);
  await accountForm.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("finance-bank-accounts-table")).toContainText(bankName);

  await page.getByRole("button", { name: "Record transaction" }).first().click();
  const txnForm = page.getByTestId("finance-bank-transaction-form");
  await txnForm.getByLabel("Bank account").selectOption({ label: bankName });
  await txnForm.getByLabel("Description").fill("E2E deposit");
  await txnForm.getByLabel("Amount").fill("500.00");
  await txnForm.getByRole("button", { name: "Record transaction" }).click();
  await expect(page.getByTestId("finance-bank-transactions-table")).toContainText("E2E deposit");

  await page.getByRole("button", { name: "New reconciliation" }).click();
  const reconForm = page.getByTestId("finance-reconciliation-form");
  await reconForm.getByLabel("Bank account").selectOption({ label: bankName });
  await reconForm.getByLabel("Period start").fill("2026-01-01");
  await reconForm.getByLabel("Period end").fill("2026-12-31");
  await reconForm.getByLabel("Statement balance").fill("500.00");
  await reconForm.getByRole("button", { name: "Open reconciliation" }).click();
  await expect(page.getByTestId("finance-reconciliations-table")).toContainText(bankName);

  const row = page.getByTestId("finance-reconciliations-table").locator("tr", { hasText: bankName });
  await row.getByRole("button", { name: "Complete" }).click();
  await expect(page.getByTestId("finance-reconciliations-table")).toContainText("completed");
});
