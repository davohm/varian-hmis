import { expect, test, type Browser, type Page } from "@playwright/test";

const PASSWORD = "VarianHMIS2026!";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(reception|triage|doctor|lab|pharmacy|cashier|admin)$/);
  await expect(page.locator("[data-testid^='screen-']").first()).toBeVisible();
}

async function registerPatientWithVisit(page: Page, suffix: string) {
  await page.goto("/reception/register");
  await expect(page.getByTestId("screen-reception-register")).toBeVisible();

  await page.getByTestId("patient-first-name").fill(`Pharm${suffix}`);
  await page.getByTestId("patient-last-name").fill("Counter");
  await page.getByTestId("patient-dob").fill("1983-05-09");
  await page.getByTestId("patient-phone").fill(`07${String(Date.now()).slice(-9)}`);
  await page.getByTestId("start-visit-checkbox").check();
  await page.getByTestId("register-patient").click();
  await page.getByTestId("registration-consent-confirm").click();

  await expect(page.getByTestId("registration-success")).toContainText(`Pharm${suffix}`);
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
  await page.getByTestId("vitals-temperature").fill("37.4");
  await page.getByTestId("vitals-spo2").fill("97");
  await page.getByTestId("vitals-weightKg").fill("74");
  await page.getByTestId("vitals-heightCm").fill("171");

  await page.getByTestId("triage-chief-complaint").fill("Fever and body aches for three days");
  await page.getByTestId("triage-comments").fill("Febrile, no rash, no vomiting");
  await page.getByTestId("triage-next-steps").fill("Doctor review and antipyretic");

  await page.getByTestId("record-triage").click();
  await expect(page.getByTestId("triage-success")).toContainText(mrn);
}

test("pharmacy dispenses a prescription with a FEFO batch and label, and the doctor sees it live", async ({
  browser,
}: {
  browser: Browser;
}) => {
  // Four signed-in stations across cold dev-server routes.
  test.slow();

  const receptionContext = await browser.newContext();
  const triageContext = await browser.newContext();
  const doctorContext = await browser.newContext();
  const pharmacyContext = await browser.newContext();
  const reception = await receptionContext.newPage();
  const triage = await triageContext.newPage();
  const doctor = await doctorContext.newPage();
  const pharmacy = await pharmacyContext.newPage();

  try {
    const mrn = await test.step("reception registers a patient and starts a visit", async () => {
      await signIn(reception, "receptionist@fam.test");
      return registerPatientWithVisit(reception, String(Date.now()).slice(-6));
    });

    await test.step("triage records vitals and hands the patient to the doctor", async () => {
      await signIn(triage, "triage@fam.test");
      await triagePatient(triage, mrn);
    });

    let encounterId = "";
    let prescriptionId = "";

    await test.step("doctor opens the consultation and prescribes paracetamol", async () => {
      await signIn(doctor, "doctor@fam.test");
      await doctor.goto("/doctor");
      await expect(doctor.getByTestId("screen-doctor")).toBeVisible();

      const queueRow = doctor.locator("[data-testid^='queue-row-']").filter({ hasText: mrn });
      await expect(queueRow).toBeVisible({ timeout: 10_000 });
      await queueRow.locator("button").click();
      await expect(doctor.getByTestId("doctor-patient-banner")).toContainText(mrn);

      const queueResponse = await doctor.request.get("/api/queue?department=Doctor");
      expect(queueResponse.status()).toBe(200);
      const queue = (await queueResponse.json()) as {
        entries: Array<{ mrn: string; encounterId: string }>;
      };
      encounterId = queue.entries.find((entry) => entry.mrn === mrn)!.encounterId;

      await doctor.getByTestId("prescribe-medicine").click();
      const paracetamol = doctor
        .getByTestId("rx-item")
        .locator("option")
        .filter({ hasText: "Paracetamol — 500 mg" })
        .first();
      const paracetamolValue = await paracetamol.getAttribute("value");
      expect(paracetamolValue).toBeTruthy();
      await doctor.getByTestId("rx-item").selectOption(paracetamolValue!);
      await doctor.getByTestId("rx-dose").fill("1 tablet");
      await doctor.getByTestId("rx-quantity").fill("10");
      await doctor.getByTestId("rx-duration").fill("5");
      await doctor.getByTestId("rx-instructions").fill("Take after food");
      await doctor.getByTestId("submit-prescription").click();

      const prescription = doctor.locator("[data-testid^='prescription-']").first();
      await expect(prescription).toContainText("Paracetamol");
      await expect(prescription).toContainText("qty 10");
      prescriptionId = (await prescription.getAttribute("data-testid"))!.replace(
        "prescription-",
        "",
      );

      const detailResponse = await doctor.request.get(`/api/doctor/encounter/${encounterId}`);
      expect(detailResponse.status()).toBe(200);
      const detail = (await detailResponse.json()) as {
        prescriptions: Array<{ id: string; status: string }>;
      };
      expect(detail.prescriptions.find((row) => row.id === prescriptionId)?.status).toBe(
        "prescribed",
      );
    });

    let stockBefore = 0;

    await test.step("pharmacy sees the prescription on the queue with a FEFO suggestion", async () => {
      await signIn(pharmacy, "pharmacist@fam.test");

      const stockResponse = await pharmacy.request.get(
        `/api/pharmacy/stock?q=${encodeURIComponent("PARA500")}`,
      );
      expect(stockResponse.status()).toBe(200);
      const stock = (await stockResponse.json()) as {
        stock: Array<{ batchNo: string; itemCode: string; quantity: number }>;
      };
      const seedBatch = stock.stock.find(
        (row) => row.itemCode === "PARA500" && row.batchNo === "SEED-2026-A",
      );
      expect(seedBatch, "seed should stock Paracetamol in SEED-2026-A").toBeTruthy();
      stockBefore = seedBatch!.quantity;

      await pharmacy.goto("/pharmacy");
      await expect(pharmacy.getByTestId("screen-pharmacy")).toBeVisible();
      await pharmacy.getByTestId("pharmacy-search").fill(mrn);

      const queued = pharmacy.getByTestId(`pharmacy-prescription-${prescriptionId}`);
      await expect(queued).toBeVisible({ timeout: 10_000 });
      await expect(queued).toContainText("Paracetamol");
      await expect(queued).toContainText("10 of 10");

      await queued.click();
      await expect(pharmacy.getByTestId("pharmacy-patient-banner")).toContainText(mrn);
      await expect(pharmacy.getByTestId("pharmacy-status")).toContainText("prescribed");
      await expect(pharmacy.getByTestId("fefo-plan")).toContainText("SEED-2026-A");
    });

    await test.step("pharmacy dispenses, prints a label and the stock drops", async () => {
      await pharmacy.getByTestId("dispense-quantity").fill("10");
      await pharmacy.getByTestId("dispense-note").fill("Counselled on taking after food");
      await pharmacy.getByTestId("dispense-submit").click();

      await expect(pharmacy.getByTestId("pharmacy-status")).toContainText("dispensed");
      const label = pharmacy.getByTestId("dispense-label");
      await expect(label).toBeVisible();
      await expect(label).toContainText(mrn);
      await expect(label).toContainText("Paracetamol");
      await expect(label).toContainText("500 mg");
      await expect(label).toContainText("Quantity dispensed: 10 tablet");
      await expect(label).toContainText("Take 1 tablet oral · twice daily");
      await expect(label).toContainText("Take after food");

      const detailResponse = await pharmacy.request.get(
        `/api/pharmacy/prescriptions/${prescriptionId}`,
      );
      expect(detailResponse.status()).toBe(200);
      const detail = (await detailResponse.json()) as {
        prescription: { status: string; dispensedQuantity: number; remaining: number };
        dispenses: Array<{ batchNo: string; quantity: number; reversedAt: string | null }>;
      };
      expect(detail.prescription).toMatchObject({
        status: "dispensed",
        dispensedQuantity: 10,
        remaining: 0,
      });
      expect(detail.dispenses).toHaveLength(1);
      expect(detail.dispenses[0]).toMatchObject({
        batchNo: "SEED-2026-A",
        quantity: 10,
        reversedAt: null,
      });

      const stockResponse = await pharmacy.request.get(
        `/api/pharmacy/stock?q=${encodeURIComponent("PARA500")}`,
      );
      const stock = (await stockResponse.json()) as {
        stock: Array<{ batchNo: string; itemCode: string; quantity: number }>;
      };
      expect(
        stock.stock.find((row) => row.itemCode === "PARA500" && row.batchNo === "SEED-2026-A")
          ?.quantity,
      ).toBe(stockBefore - 10);
    });

    await test.step("the doctor sees the dispensed prescription live", async () => {
      // The doctor's SSE listener reloads the encounter on prescription_dispensed.
      const row = doctor.getByTestId(`prescription-${prescriptionId}`);
      await expect(row).toContainText("dispensed");
      await expect(row).toContainText("Paracetamol");
    });

    await test.step("pharmacy reverses the dispense and the stock is restored", async () => {
      await pharmacy.getByTestId("reverse-note").fill("Patient returned the medicine");
      await pharmacy.getByTestId("reverse-submit").click();

      await expect(pharmacy.getByTestId("pharmacy-status")).toContainText("prescribed");
      await expect(pharmacy.getByTestId("dispense-label")).toHaveCount(0);
      await expect(pharmacy.getByTestId("dispense-history")).toContainText("reversed");

      const stockResponse = await pharmacy.request.get(
        `/api/pharmacy/stock?q=${encodeURIComponent("PARA500")}`,
      );
      const stock = (await stockResponse.json()) as {
        stock: Array<{ batchNo: string; itemCode: string; quantity: number }>;
      };
      expect(
        stock.stock.find((row) => row.itemCode === "PARA500" && row.batchNo === "SEED-2026-A")
          ?.quantity,
      ).toBe(stockBefore);

      await expect(doctor.getByTestId(`prescription-${prescriptionId}`)).toContainText(
        "prescribed",
      );
    });
  } finally {
    await receptionContext.close();
    await triageContext.close();
    await doctorContext.close();
    await pharmacyContext.close();
  }
});
