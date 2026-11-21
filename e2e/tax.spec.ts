import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { newId } from "../src/lib/uuid";
import {
  branches,
  charges,
  encounters,
  etimsInvoiceQueue,
  facilities,
  invoices,
  patients,
  services,
} from "../src/server/db/schema";
import { nextFormattedNumber } from "../src/server/numbering";
import { createTestDatabase, type TestDatabase } from "../tests/helpers";

const PASSWORD = "VarianHMIS2026!";

let ctx: TestDatabase;

test.beforeAll(() => {
  ctx = createTestDatabase();
});

test.afterAll(async () => {
  await ctx.pool.end();
});

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
  input: Record<string, unknown> = {},
): Promise<T> {
  const response = await page.request.post("/api/finance/tax", {
    data: {
      command,
      input: { idempotencyKey: randomUUID(), ...input },
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { result: T };
  return body.result;
}

interface InvoiceFixture {
  invoiceId: string;
  invoiceNo: string;
  patientName: string;
}

/** Creates a finalisable invoice with one charge against the seeded KRA facility. */
async function createFinalisableInvoice(): Promise<InvoiceFixture> {
  const facilityRows = await ctx.db
    .select()
    .from(facilities)
    .where(eq(facilities.code, "FAM"))
    .limit(1);
  const facility = facilityRows[0];
  if (!facility) throw new Error("Seeded FAM facility is missing");

  const branchRows = await ctx.db
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.facilityId, facility.id))
    .limit(1);
  const serviceRows = await ctx.db
    .select({ id: services.id })
    .from(services)
    .where(eq(services.code, "CONS"))
    .limit(1);
  if (!branchRows[0] || !serviceRows[0]) {
    throw new Error("Seeded branch or consultation service is missing");
  }

  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const patientId = newId();
  const firstName = `E2E${suffix}`;
  await ctx.db.insert(patients).values({
    id: patientId,
    facilityId: facility.id,
    mrn: `TAXE2E-${suffix}`,
    firstName,
    lastName: "KRA",
    sex: "female",
    payerType: "cash",
    createdBy: "e2e-tax",
  });

  const encounterId = newId();
  await ctx.db.insert(encounters).values({
    id: encounterId,
    facilityId: facility.id,
    branchId: branchRows[0].id,
    patientId,
    encounterNo: `TAXEE-${suffix}`,
    payerType: "cash",
    createdBy: "e2e-tax",
  });

  const invoiceNo = await nextFormattedNumber(ctx.db, facility, "invoice", "FAH");
  const invoiceId = newId();
  await ctx.db.insert(invoices).values({
    id: invoiceId,
    facilityId: facility.id,
    encounterId,
    invoiceNo,
    subtotal: "1000.00",
    total: "1000.00",
    paid: "0.00",
    status: "open",
    createdBy: "e2e-tax",
  });

  await ctx.db.insert(charges).values({
    id: newId(),
    facilityId: facility.id,
    encounterId,
    invoiceId,
    sourceType: "tax-e2e",
    sourceId: suffix,
    serviceId: serviceRows[0].id,
    description: "General Consultation",
    quantity: 1,
    unitPrice: "1000.00",
    amount: "1000.00",
    createdBy: "e2e-tax",
  });

  return { invoiceId, invoiceNo, patientName: `${firstName} KRA` };
}

test("finance staff can sign, filter, refresh, retry and print KRA documents while other roles stay guarded", async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.slow();

  const accountantContext = await browser.newContext();
  const auditorContext = await browser.newContext();
  const cashierContext = await browser.newContext();

  await accountantContext.addInitScript(() => {
    const state = window as unknown as { __taxPrints?: string[] };
    state.__taxPrints = [];
    window.print = () => {
      state.__taxPrints?.push("print");
    };
  });

  const accountant = await accountantContext.newPage();
  const auditor = await auditorContext.newPage();
  const cashier = await cashierContext.newPage();

  try {
    const signatureInvoice = await createFinalisableInvoice();
    const retryInvoice = await createFinalisableInvoice();

    await test.step("cashier is refused the tax API and screen", async () => {
      await signIn(cashier, "cashier@fam.test");

      const get = await cashier.request.get("/api/finance/tax");
      expect(get.status()).toBe(403);
      const post = await cashier.request.post("/api/finance/tax", {
        data: {
          command: "generateEtimsSignature",
          input: { idempotencyKey: randomUUID(), invoiceId: signatureInvoice.invoiceId },
        },
      });
      expect(post.status()).toBe(403);

      await cashier.goto("/finance/tax");
      await expect(cashier.getByTestId("screen-forbidden")).toBeVisible();
      await expect(cashier.getByTestId("screen-tax")).toHaveCount(0);
    });

    await test.step("auditor keeps read-only access", async () => {
      await signIn(auditor, "auditor@fam.test");

      const get = await auditor.request.get("/api/finance/tax");
      expect(get.status()).toBe(200);
      const post = await auditor.request.post("/api/finance/tax", {
        data: {
          command: "generateEtimsSignature",
          input: { idempotencyKey: randomUUID(), invoiceId: signatureInvoice.invoiceId },
        },
      });
      expect(post.status()).toBe(403);

      await auditor.goto("/finance/tax");
      await expect(auditor.getByTestId("screen-tax")).toBeVisible();
      await expect(auditor.getByTestId("tax-transactions-table")).toBeVisible();
      await expect(auditor.getByTestId("tax-generate-signature")).toBeDisabled();
      await expect(auditor.getByTestId("tax-retry")).toBeDisabled();
      await expect(auditor.getByTestId("tax-save-code")).toHaveCount(0);
    });

    let controlNo = "";
    let signature = "";

    await test.step("accountant generates the KRA signature and QR", async () => {
      await signIn(accountant, "accountant@fam.test");
      await accountant.goto("/finance/tax");
      await expect(accountant.getByTestId("screen-tax")).toBeVisible();
      await expect(accountant.getByTestId("tax-workspace")).toBeVisible();

      await accountant.getByTestId("tax-filter-search").fill(signatureInvoice.invoiceNo);
      await expect(accountant.locator("[data-testid^='tax-row-']")).toHaveCount(0);

      const option = accountant.locator(
        `[data-testid='tax-invoice-select'] option[value='${signatureInvoice.invoiceId}']`,
      );
      await expect(option).toHaveCount(1);
      await accountant.getByTestId("tax-invoice-select").selectOption(signatureInvoice.invoiceId);
      await expect(accountant.getByTestId("tax-generate-signature")).toBeEnabled();
      await accountant.getByTestId("tax-generate-signature").click();

      const row = accountant
        .locator("[data-testid^='tax-row-']")
        .filter({ hasText: signatureInvoice.invoiceNo });
      await expect(row).toHaveCount(1, { timeout: 30_000 });
      await expect(row).toContainText(signatureInvoice.patientName);
      const controlValue = accountant.getByTestId("tax-control-number").locator("dd");
      await expect(controlValue).toHaveText(/^KRA-/, { timeout: 30_000 });

      controlNo = (await controlValue.innerText()).trim();
      signature = (await accountant.getByTestId("tax-signature").innerText()).trim();
      expect(controlNo).toMatch(/^KRA-[A-F0-9]{10}$/);
      expect(signature).toMatch(/^SIG-[A-F0-9]{10}$/);

      await expect(accountant.getByTestId("tax-qr-preview").locator("img")).toHaveAttribute(
        "src",
        /^data:image\/svg\+xml;base64,/,
      );
    });

    await test.step("table filters narrow by invoice, status and date", async () => {
      await expect(accountant.getByTestId("tax-transactions-table")).toContainText(
        signatureInvoice.invoiceNo,
      );
      await expect(accountant.locator("[data-testid^='tax-row-']")).toHaveCount(1);

      await accountant.getByTestId("tax-filter-status").selectOption("acknowledged");
      await expect(accountant.locator("[data-testid^='tax-row-']")).toHaveCount(1);

      await accountant.getByTestId("tax-filter-from").fill("2099-01-01");
      await expect(accountant.locator("[data-testid^='tax-row-']")).toHaveCount(0);

      await accountant.getByTestId("tax-filter-from").fill("");
      await expect(accountant.locator("[data-testid^='tax-row-']")).toHaveCount(1);
    });

    await test.step("status refresh shows the KRA acknowledgement log", async () => {
      await accountant.getByTestId("tax-refresh-status").click();
      const detail = accountant.getByTestId("tax-detail-panel");
      await expect(detail.getByText("acknowledged", { exact: true })).toBeVisible();
      await expect(detail).toContainText("200");
      await expect(detail).toContainText("00");
    });

    await test.step("print sheet carries the control number, signature and QR", async () => {
      await accountant.getByTestId("tax-print").click();
      const prints = await accountant.evaluate(
        () => (window as unknown as { __taxPrints?: string[] }).__taxPrints ?? [],
      );
      expect(prints).toContain("print");

      const sheet = accountant.getByTestId("tax-print-sheet");
      await expect(sheet).toContainText("KRA eTIMS TAX INVOICE");
      await expect(sheet).toContainText(signatureInvoice.invoiceNo);
      await expect(accountant.getByTestId("tax-print-control")).toHaveText(controlNo);
      await expect(accountant.getByTestId("tax-print-signature")).toHaveText(signature);
      await expect(accountant.getByTestId("tax-print-qr")).toHaveAttribute(
        "src",
        /^data:image\/svg\+xml;base64,/,
      );
    });

    await test.step("a failed document can be retried into acknowledgement", async () => {
      await accountant.getByTestId("tax-filter-search").fill("");
      await accountant.getByTestId("tax-filter-status").selectOption("");

      const queued = await apiPost<{ queueId: string }>(accountant, "finalizeInvoice", {
        invoiceId: retryInvoice.invoiceId,
        environment: "sandbox",
      });
      expect(queued.queueId).toMatch(/^[0-9a-f-]{36}$/i);

      await ctx.db
        .update(etimsInvoiceQueue)
        .set({
          status: "failed",
          attempts: 1,
          nextAttemptAt: new Date(Date.now() - 1_000),
          lastError: "Simulated KRA timeout",
          responseMessage: "Simulated KRA timeout",
        })
        .where(eq(etimsInvoiceQueue.id, queued.queueId));

      await accountant.reload();
      await expect(accountant.getByTestId("tax-workspace")).toBeVisible();

      const failedRow = accountant
        .locator("[data-testid^='tax-row-']")
        .filter({ hasText: retryInvoice.invoiceNo });
      await expect(failedRow).toHaveCount(1, { timeout: 30_000 });
      await expect(failedRow).toContainText("Failed");
      await failedRow.click();

      await expect(accountant.getByTestId("tax-retry")).toBeEnabled();
      await accountant.getByTestId("tax-retry").click();

      await expect(failedRow).toContainText("Acknowledged", { timeout: 30_000 });
      await expect(
        accountant.getByTestId("tax-control-number").locator("dd"),
      ).toHaveText(/^KRA-/, { timeout: 30_000 });
      await expect(accountant.getByTestId("tax-retry")).toBeDisabled();
    });
  } finally {
    await accountantContext.close();
    await auditorContext.close();
    await cashierContext.close();
  }
});
