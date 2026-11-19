import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

const PASSWORD = "VarianHMIS2026!";
const OPENING_FLOAT = 500;
const VISIT_TOTAL = 1800;

interface SessionView {
  sessionId: string;
  openedAt: string;
  closedAt: string | null;
  openingFloat: string;
  expectedCash: string | null;
  countedCash: string | null;
  variance: string | null;
  isOpen: boolean;
  totalCollected: string;
  paymentCount: number;
}

interface BillPayment {
  id: string;
  receiptNo: string;
  amount: string;
  method: string;
  reference: string | null;
  reversedPaymentId: string | null;
}

interface EncounterBill {
  invoice: {
    id: string;
    invoiceNo: string;
    status: string;
    total: string;
    paid: string;
    outstanding: string;
  } | null;
  charges: Array<{
    sourceType: string;
    description: string;
    amount: string;
    voidedAt: string | null;
  }>;
  payments: BillPayment[];
  unbilledTotal: string;
  outstanding: string;
}

interface EndOfDayReport {
  session: SessionView;
  payments: Array<{
    receiptNo: string;
    method: string;
    amount: string;
    reference: string | null;
    isReversal: boolean;
  }>;
  totalCollected: string;
  totalReversed: string;
  netCollected: string;
  cashExpected: string;
  invoiceCount: number;
  paidInvoiceCount: number;
  invoiceTotal: string;
  invoicePaid: string;
}

/** The numeric(12,2) string the API stores and the UI inputs accept. */
function amountText(value: number): string {
  return value.toFixed(2);
}

/** The currency string the cashier workspace renders (en-KE, two decimals). */
function money(value: string | number): string {
  const parsed = typeof value === "number" ? value : Number(value);
  return `KSh ${parsed.toLocaleString("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(reception|triage|doctor|lab|pharmacy|cashier|admin)$/);
  await expect(page.locator("[data-testid^='screen-']").first()).toBeVisible();
}

async function registerPatientWithVisit(page: Page, suffix: string) {
  await page.goto("/reception");
  await expect(page.getByTestId("screen-reception")).toBeVisible();

  await page.getByTestId("patient-first-name").fill(`Cash${suffix}`);
  await page.getByTestId("patient-last-name").fill("Till");
  await page.getByTestId("patient-dob").fill("1981-11-02");
  await page.getByTestId("patient-phone").fill(`07${String(Date.now()).slice(-9)}`);
  await page.getByTestId("start-visit-checkbox").check();
  await page.getByTestId("register-patient").click();

  await expect(page.getByTestId("registration-success")).toContainText(`Cash${suffix}`);
  const banner = await page.getByTestId("registration-success").innerText();
  const mrn = banner.match(/[A-Z]+-\d{2}-\d{5}/)?.[0];
  expect(mrn, `MRN should be shown in the registration banner: ${banner}`).toBeTruthy();
  return mrn!;
}

/** Triage the waiting patient so they land in the doctor queue. */
async function triagePatient(page: Page, mrn: string) {
  await page.goto("/triage");
  await expect(page.getByTestId("screen-triage")).toBeVisible();

  const queueRow = page.locator("[data-testid^='queue-row-']").filter({ hasText: mrn });
  await expect(queueRow).toBeVisible({ timeout: 10_000 });
  await queueRow.locator("button").click();
  await expect(page.getByTestId("triage-patient-banner")).toContainText(mrn);

  await page.getByTestId("vitals-systolic").fill("126");
  await page.getByTestId("vitals-diastolic").fill("82");
  await page.getByTestId("vitals-heartRate").fill("78");
  await page.getByTestId("vitals-respRate").fill("18");
  await page.getByTestId("vitals-temperature").fill("36.8");
  await page.getByTestId("vitals-spo2").fill("98");
  await page.getByTestId("vitals-weightKg").fill("68");
  await page.getByTestId("vitals-heightCm").fill("171");

  await page.getByTestId("triage-chief-complaint").fill("Fever and general body weakness");
  await page.getByTestId("triage-comments").fill("Alert, no respiratory distress");
  await page.getByTestId("triage-next-steps").fill("Doctor review and full blood count");

  await page.getByTestId("record-triage").click();
  await expect(page.getByTestId("triage-success")).toContainText(mrn);
}

/** Open the consultation and order the lab test that makes the visit billable. */
async function orderBloods(page: Page, mrn: string): Promise<string> {
  await page.goto("/doctor");
  await expect(page.getByTestId("screen-doctor")).toBeVisible();

  const queueRow = page.locator("[data-testid^='queue-row-']").filter({ hasText: mrn });
  await expect(queueRow).toBeVisible({ timeout: 10_000 });
  await queueRow.locator("button").click();
  await expect(page.getByTestId("doctor-patient-banner")).toContainText(mrn);

  const queueResponse = await page.request.get("/api/queue?department=Doctor");
  expect(queueResponse.status()).toBe(200);
  const queue = (await queueResponse.json()) as {
    entries: Array<{ mrn: string; encounterId: string }>;
  };
  const encounterId = queue.entries.find((entry) => entry.mrn === mrn)!.encounterId;

  await page.getByTestId("order-lab-tests").click();
  await page.getByTestId("lab-test-option-FBC").check();
  await page.getByTestId("lab-clinical-notes").fill("Fever: rule out malaria and anaemia");
  await page.getByTestId("submit-lab-order").click();

  const labOrder = page.locator("[data-testid^='lab-order-']").first();
  await expect(labOrder).toContainText("Ordered");
  await expect(labOrder).toContainText("Full Blood Count");

  return encounterId;
}

async function readSessions(
  page: Page,
): Promise<{ current: SessionView | null; recent: SessionView[] }> {
  const response = await page.request.get("/api/cashier/sessions");
  expect(response.status()).toBe(200);
  return (await response.json()) as { current: SessionView | null; recent: SessionView[] };
}

async function readBill(page: Page, encounterId: string): Promise<EncounterBill> {
  const response = await page.request.get(`/api/cashier/encounters/${encounterId}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as EncounterBill;
}

/** Pop-ups are stubbed so the print button can be asserted without a printer. */
async function readPrintouts(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __printouts?: string[] }).__printouts ?? [],
  );
}

test("cashier bills a visit, takes a split tender, reverses a tender and closes the drawer", async ({
  browser,
}: {
  browser: Browser;
}) => {
  // Four signed-in stations across cold dev-server routes.
  test.slow();

  const receptionContext = await browser.newContext();
  const triageContext = await browser.newContext();
  const doctorContext = await browser.newContext();
  const cashierContext = await browser.newContext();
  await cashierContext.addInitScript(() => {
    const printouts: string[] = [];
    (window as unknown as { __printouts: string[] }).__printouts = printouts;
    const fakeOpen = () => ({
      document: {
        write: (html: string) => printouts.push(html),
        close: () => undefined,
      },
      focus: () => undefined,
      print: () => undefined,
    });
    (window as unknown as { open: () => unknown }).open = fakeOpen;
  });

  const reception = await receptionContext.newPage();
  const triage = await triageContext.newPage();
  const doctor = await doctorContext.newPage();
  const cashier = await cashierContext.newPage();

  try {
    const mrn = await test.step("reception registers a patient and starts a visit", async () => {
      await signIn(reception, "receptionist@fam.test");
      return registerPatientWithVisit(reception, String(Date.now()).slice(-6));
    });

    await test.step("triage records vitals and hands the patient to the doctor", async () => {
      await signIn(triage, "triage@fam.test");
      await triagePatient(triage, mrn);
    });

    const encounterId = await test.step("the doctor opens the visit and orders a full blood count", async () => {
      await signIn(doctor, "doctor@fam.test");
      return orderBloods(doctor, mrn);
    });

    let sessionId = "";
    let expectedCash = "";

    await test.step("the cashier opens a drawer", async () => {
      await signIn(cashier, "cashier@fam.test");
      await cashier.goto("/cashier");
      await expect(cashier.getByTestId("screen-cashier")).toBeVisible();

      // A drawer left open by an interrupted run would mix its receipts into
      // this reconciliation, so settle it before opening a fresh one.
      const before = await readSessions(cashier);
      if (before.current) {
        const stale = before.current;
        const closed = await cashier.request.post("/api/cashier/sessions/close", {
          data: {
            sessionId: stale.sessionId,
            countedCash: Number(stale.expectedCash ?? stale.openingFloat),
            note: "Closed by the cashier e2e run",
            idempotencyKey: randomUUID(),
          },
        });
        expect(closed.status()).toBe(201);
        await cashier.reload();
        await expect(cashier.getByTestId("screen-cashier")).toBeVisible();
      }

      await cashier.getByTestId("opening-float").fill(String(OPENING_FLOAT));
      await cashier.getByTestId("open-session").click();
      await expect(cashier.getByTestId("session-status")).toContainText("Session open");

      const opened = await readSessions(cashier);
      expect(opened.current).not.toBeNull();
      sessionId = opened.current!.sessionId;
      expect(opened.current!.openingFloat).toBe(amountText(OPENING_FLOAT));
      expectedCash = amountText(OPENING_FLOAT + 1000);
    });

    await test.step("the cashier raises the invoice for the visit", async () => {
      await cashier.getByTestId("cashier-search").fill(mrn);
      const queueRow = cashier.getByTestId("cashier-queue-item").filter({ hasText: mrn });
      await expect(queueRow).toBeVisible();
      await queueRow.click();

      const billCard = cashier.getByTestId("cashier-bill");
      await expect(billCard).toContainText(mrn);
      await expect(billCard).toContainText("General Consultation");
      await expect(billCard).toContainText("Full Blood Count");
      await expect(billCard).toContainText(money(VISIT_TOTAL));
      await expect(billCard).toContainText("Not invoiced");

      // The consultation and the lab order each synced a charge.
      const unbilled = await readBill(cashier, encounterId);
      expect(unbilled.invoice).toBeNull();
      expect(unbilled.charges.map((charge) => charge.sourceType).sort()).toEqual([
        "consultation",
        "lab",
      ]);
      expect(unbilled.charges.map((charge) => charge.amount).sort()).toEqual([
        "1000.00",
        "800.00",
      ]);
      expect(unbilled.unbilledTotal).toBe("1800.00");
      expect(unbilled.outstanding).toBe("1800.00");

      await cashier.getByTestId("open-invoice").click();
      await expect(billCard).toContainText(/[A-Z]+-I-\d{2}-\d{6}/);
      await expect(billCard).toContainText("Open");
      await expect(cashier.getByTestId("payment-panel")).toBeVisible();
    });

    let cashReceiptNo = "";
    let mpesaReceiptNo = "";

    await test.step("the cashier takes a split tender: cash and M-Pesa", async () => {
      await expect(cashier.getByTestId("tender-amount-0")).toHaveValue("1800.00");
      await cashier.getByTestId("tender-amount-0").fill("1000");
      await cashier.getByTestId("add-tender").click();
      await cashier.getByTestId("tender-method-1").selectOption("mpesa");
      await cashier.getByTestId("tender-amount-1").fill("800");
      await cashier.getByTestId("tender-reference-1").fill("QK47ABCDE1");
      await cashier.getByTestId("payment-note").fill("Cash and M-Pesa split");
      await cashier.getByTestId("take-payment").click();

      const receipts = cashier.getByTestId("payment-receipt");
      await expect(receipts).toHaveCount(2);
      await expect(receipts.first()).toContainText(/[A-Z]+-R-\d{2}-\d{6}/);
      await expect(receipts.first()).toContainText("Payment: Cash");
      await expect(receipts.nth(1)).toContainText("M-Pesa");
      await expect(receipts.nth(1)).toContainText("QK47ABCDE1");

      const bill = await readBill(cashier, encounterId);
      expect(bill.invoice?.status).toBe("paid");
      expect(bill.invoice?.paid).toBe("1800.00");
      expect(bill.outstanding).toBe("0.00");
      expect(bill.payments).toHaveLength(2);

      const cash = bill.payments.find((payment) => payment.method === "cash")!;
      const mpesa = bill.payments.find((payment) => payment.method === "mpesa")!;
      expect(cash.amount).toBe("1000.00");
      expect(mpesa.amount).toBe("800.00");
      expect(mpesa.reference).toBe("QK47ABCDE1");
      cashReceiptNo = cash.receiptNo;
      mpesaReceiptNo = mpesa.receiptNo;
      expect(cashReceiptNo).not.toBe(mpesaReceiptNo);

      const receiptResponse = await cashier.request.get(`/api/cashier/receipts/${mpesa.id}`);
      expect(receiptResponse.status()).toBe(200);
      const receipt = (await receiptResponse.json()) as {
        receipt: { receiptNo: string; total: string; paid: string; outstanding: string };
        text: string;
      };
      expect(receipt.receipt.receiptNo).toBe(mpesaReceiptNo);
      expect(receipt.receipt.total).toBe("1800.00");
      expect(receipt.receipt.paid).toBe("1800.00");
      expect(receipt.receipt.outstanding).toBe("0.00");
      expect(receipt.text).toContain("Payment: M-Pesa");
      expect(receipt.text).toContain("QK47ABCDE1");
      // 80 mm thermal paper is 40 monospace characters wide.
      for (const line of receipt.text.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
    });

    await test.step("the cashier prints the 80 mm receipt", async () => {
      await cashier.getByTestId("payment-receipt").first().getByTestId("print-receipt").click();

      const printouts = await readPrintouts(cashier);
      expect(printouts).toHaveLength(1);
      expect(printouts[0]).toContain("<title>Receipt</title>");
      expect(printouts[0]).toContain("@page { size: 80mm auto;");
      expect(printouts[0]).toContain(cashReceiptNo);
      expect(printouts[0]).toContain("Payment: Cash");
    });

    await test.step("the cashier reverses the M-Pesa tender", async () => {
      const ledger = cashier.getByTestId("payment-ledger");
      const mpesaRow = ledger.locator("tr").filter({ hasText: "M-Pesa" });
      await expect(mpesaRow).toHaveCount(1);
      await mpesaRow.getByTestId("reverse-payment").click();

      await cashier.getByTestId("reverse-reason").fill("M-Pesa was confirmed twice at the till");
      await cashier.getByTestId("confirm-reverse").click();

      await expect(ledger).toContainText("reverses");
      await expect(ledger).toContainText("reversed");
      await expect(ledger).toContainText(money(-800));
      await expect(ledger.locator("tr").filter({ hasText: "M-Pesa" })).toHaveCount(2);

      const bill = await readBill(cashier, encounterId);
      expect(bill.invoice?.status).toBe("partial");
      expect(bill.invoice?.paid).toBe("1000.00");
      expect(bill.outstanding).toBe("800.00");
      expect(bill.payments).toHaveLength(3);

      const reversal = bill.payments.find((payment) => payment.reversedPaymentId != null)!;
      expect(reversal.amount).toBe("-800.00");
      expect(reversal.reference).toBe(mpesaReceiptNo);
      expect(reversal.reversedPaymentId).toBe(
        bill.payments.find((payment) => payment.receiptNo === mpesaReceiptNo)!.id,
      );

      const reversalResponse = await cashier.request.get(`/api/cashier/receipts/${reversal.id}`);
      expect(reversalResponse.status()).toBe(200);
      const reversalReceipt = (await reversalResponse.json()) as {
        receipt: { isReversal: boolean; receiptNo: string };
        text: string;
      };
      expect(reversalReceipt.receipt.isReversal).toBe(true);
      expect(reversalReceipt.text).toContain("Payment: M-Pesa");
      expect(reversalReceipt.text).toContain("-800.00");
    });

    await test.step("the cashier settles the balance by card", async () => {
      await expect(cashier.getByTestId("payment-panel")).toBeVisible();
      await expect(cashier.getByTestId("tender-amount-0")).toHaveValue("800.00");
      await cashier.getByTestId("tender-method-0").selectOption("card");
      await cashier.getByTestId("tender-reference-0").fill("CARD-4471");
      await cashier.getByTestId("take-payment").click();

      const receipts = cashier.getByTestId("payment-receipt");
      await expect(receipts).toHaveCount(1);
      await expect(receipts.first()).toContainText("Card");

      const bill = await readBill(cashier, encounterId);
      expect(bill.invoice?.status).toBe("paid");
      expect(bill.invoice?.paid).toBe("1800.00");
      expect(bill.outstanding).toBe("0.00");
      expect(bill.payments).toHaveLength(4);
      await expect(cashier.getByTestId("cashier-bill")).toContainText("Paid");
    });

    await test.step("the cashier closes the drawer and reconciles the day", async () => {
      await cashier.getByTestId("cashier-tab-sessions").click();

      const panel = cashier.getByTestId("session-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("Cash (1)");
      await expect(panel).toContainText("M-Pesa (2)");
      await expect(panel).toContainText("Card (1)");
      await expect(panel).toContainText(money(1800));

      await cashier.getByTestId("counted-cash").fill(amountText(OPENING_FLOAT + 1000));
      await cashier.getByTestId("close-note").fill("Drawer counted at close");
      await cashier.getByTestId("close-session").click();

      await expect(cashier.getByTestId("session-status")).toContainText("No session open");

      const report = cashier.getByTestId("eod-report");
      await expect(report).toContainText("End-of-day report");
      await expect(report).toContainText(money(2600));
      await expect(report).toContainText(money(-800));
      await expect(report).toContainText(money(OPENING_FLOAT + 1000));
      await expect(report).toContainText(`Net collected ${money(1800)}`);
      await expect(report).toContainText("1 paid in full");
      await expect(report).toContainText(cashReceiptNo);
      await expect(report).toContainText(mpesaReceiptNo);

      await cashier.getByTestId("print-report").click();
      const printouts = await readPrintouts(cashier);
      expect(printouts).toHaveLength(2);
      expect(printouts[1]).toContain("<title>End of day</title>");
      expect(printouts[1]).toContain(`Cash expected: ${money(OPENING_FLOAT + 1000)}`);
      expect(printouts[1]).toContain(cashReceiptNo);

      const reportResponse = await cashier.request.get(
        `/api/cashier/sessions/report?sessionId=${sessionId}`,
      );
      expect(reportResponse.status()).toBe(200);
      const day = (await reportResponse.json()) as EndOfDayReport;
      expect(day.session.sessionId).toBe(sessionId);
      expect(day.session.isOpen).toBe(false);
      expect(day.session.openingFloat).toBe(amountText(OPENING_FLOAT));
      expect(day.session.expectedCash).toBe(expectedCash);
      expect(day.session.countedCash).toBe(expectedCash);
      expect(day.session.variance).toBe("0.00");
      expect(day.totalCollected).toBe("2600.00");
      expect(day.totalReversed).toBe("-800.00");
      expect(day.netCollected).toBe("1800.00");
      expect(day.cashExpected).toBe(expectedCash);
      expect(day.invoiceCount).toBe(1);
      expect(day.paidInvoiceCount).toBe(1);
      expect(day.invoiceTotal).toBe("1800.00");
      expect(day.invoicePaid).toBe("1800.00");
      expect(day.payments).toHaveLength(4);
      expect(day.payments.filter((payment) => payment.isReversal)).toHaveLength(1);

      // Every tender drew its own receipt from one sequential counter.
      const sequence = day.payments
        .map((payment) => {
          expect(payment.receiptNo).toMatch(/^[A-Z]+-R-\d{2}-\d{6}$/);
          return Number(payment.receiptNo.split("-").at(-1));
        })
        .sort((left, right) => left - right);
      expect(sequence).toEqual([
        sequence[0],
        sequence[0] + 1,
        sequence[0] + 2,
        sequence[0] + 3,
      ]);

      const sessions = await readSessions(cashier);
      expect(sessions.current).toBeNull();
      expect(sessions.recent.map((entry) => entry.sessionId)).toContain(sessionId);
    });
  } finally {
    await receptionContext.close();
    await triageContext.close();
    await doctorContext.close();
    await cashierContext.close();
  }
});
