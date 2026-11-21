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
  await page.goto("/reception");
  await expect(page.getByTestId("screen-reception")).toBeVisible();

  await page.getByTestId("patient-first-name").fill(`Lab${suffix}`);
  await page.getByTestId("patient-last-name").fill("Specimen");
  await page.getByTestId("patient-dob").fill("1986-02-14");
  await page.getByTestId("patient-phone").fill(`07${String(Date.now()).slice(-9)}`);
  await page.getByTestId("start-visit-checkbox").check();
  await page.getByTestId("register-patient").click();
  await page.getByTestId("registration-consent-confirm").click();

  await expect(page.getByTestId("registration-success")).toContainText(`Lab${suffix}`);
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

  await page.getByTestId("vitals-systolic").fill("124");
  await page.getByTestId("vitals-diastolic").fill("80");
  await page.getByTestId("vitals-heartRate").fill("74");
  await page.getByTestId("vitals-respRate").fill("16");
  await page.getByTestId("vitals-temperature").fill("36.6");
  await page.getByTestId("vitals-spo2").fill("99");
  await page.getByTestId("vitals-weightKg").fill("71");
  await page.getByTestId("vitals-heightCm").fill("168");

  await page.getByTestId("triage-chief-complaint").fill("Fatigue and dizziness for two weeks");
  await page.getByTestId("triage-comments").fill("Pale conjunctivae, no bleeding, no fever");
  await page.getByTestId("triage-next-steps").fill("Doctor review and full blood count");

  await page.getByTestId("record-triage").click();
  await expect(page.getByTestId("triage-success")).toContainText(mrn);
}

test("laboratory collects, results and verifies an order, and the doctor sees it live", async ({
  browser,
}: {
  browser: Browser;
}) => {
  // Four signed-in stations across cold dev-server routes.
  test.slow();

  const receptionContext = await browser.newContext();
  const triageContext = await browser.newContext();
  const doctorContext = await browser.newContext();
  const labContext = await browser.newContext();
  const reception = await receptionContext.newPage();
  const triage = await triageContext.newPage();
  const doctor = await doctorContext.newPage();
  const lab = await labContext.newPage();

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
    let labOrderId = "";
    let itemId = "";

    await test.step("doctor opens the consultation and orders a full blood count", async () => {
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

      await doctor.getByTestId("order-lab-tests").click();
      await doctor.getByTestId("lab-test-option-FBC").check();
      await doctor.getByTestId("lab-clinical-notes").fill("Fatigue: rule out anaemia");
      await doctor.getByTestId("submit-lab-order").click();

      const labOrder = doctor.locator("[data-testid^='lab-order-']").first();
      await expect(labOrder).toContainText("Ordered");
      await expect(labOrder).toContainText("Full Blood Count");
      labOrderId = (await labOrder.getAttribute("data-testid"))!.replace("lab-order-", "");

      // An unverified order keeps the visit open.
      await expect(doctor.getByTestId("doctor-outcome")).toContainText("still outstanding");
      await expect(doctor.getByTestId("discharge-visit")).toBeDisabled();
    });

    await test.step("laboratory collects the sample and starts processing", async () => {
      await signIn(lab, "lab@fam.test");
      await lab.goto("/lab");
      await expect(lab.getByTestId("screen-lab")).toBeVisible();
      await expect(lab.getByTestId("lab-catalog")).toContainText("Full Blood Count");

      const worklistResponse = await lab.request.get(
        `/api/lab/worklist?filter=pending&q=${encodeURIComponent(mrn)}`,
      );
      expect(worklistResponse.status()).toBe(200);
      const worklist = (await worklistResponse.json()) as {
        orders: Array<{ id: string; mrn: string }>;
      };
      expect(worklist.orders.map((order) => order.id)).toContain(labOrderId);

      await lab.getByTestId("lab-search").fill(mrn);
      const orderRow = lab.getByTestId(`lab-order-${labOrderId}`);
      await expect(orderRow).toBeVisible();
      await orderRow.click();
      await expect(lab.getByTestId("lab-patient-banner")).toContainText(mrn);
      await expect(lab.getByTestId("lab-patient-banner")).toContainText(
        "Fatigue: rule out anaemia",
      );
      await expect(lab.getByTestId("lab-status")).toContainText("Ordered");

      await lab.getByTestId("lab-collect").click();
      await expect(lab.getByTestId("lab-status")).toContainText("Sample collected");
      await expect(lab.getByTestId("lab-patient-banner")).toContainText(/Sample .+-S-\d{2}-\d{6}/);

      await lab.getByTestId("lab-start").click();
      await expect(lab.getByTestId("lab-status")).toContainText("In progress");
    });

    await test.step("laboratory enters every parameter and saves the results", async () => {
      const item = lab.locator("[data-testid^='lab-item-']").first();
      await expect(item).toContainText("Full Blood Count");
      itemId = (await item.getAttribute("data-testid"))!.replace("lab-item-", "");

      await lab.getByTestId(`lab-result-input-${itemId}-haemoglobin`).fill("10.4");
      await lab.getByTestId(`lab-result-input-${itemId}-white-cell-count`).fill("6.2");
      await lab.getByTestId(`lab-result-input-${itemId}-platelets`).fill("210");
      await lab.getByTestId(`lab-result-input-${itemId}-mcv`).fill("88");

      await lab.getByTestId("lab-save-results").click();
      await expect(lab.getByTestId("lab-status")).toContainText("Resulted");
      await expect(item).toContainText("4/4 parameters");

      // The values auto-flagged against the reference range: haemoglobin is low.
      await expect(lab.getByTestId(`lab-result-input-${itemId}-haemoglobin`)).toHaveValue("10.4");
      await expect(item).toContainText("Low");

      // A resulted but unverified order still blocks closing the visit.
      await expect(doctor.getByTestId("lab-order-" + labOrderId)).toContainText("Resulted");
      await expect(doctor.getByTestId("discharge-visit")).toBeDisabled();
      await expect(doctor.getByTestId("lab-order-" + labOrderId)).not.toContainText("Haemoglobin");
    });

    await test.step("laboratory verifies the results and releases them to the doctor", async () => {
      await lab.getByTestId("lab-verify").click();
      await expect(lab.getByTestId("lab-status")).toContainText("Verified");
      await expect(
        lab.getByText("Verified results are locked and visible to the doctor."),
      ).toBeVisible();
      // Verified values are read-only: the inputs are replaced by plain text.
      await expect(lab.getByTestId(`lab-result-input-${itemId}-haemoglobin`)).toHaveCount(0);
      await expect(lab.getByTestId(`lab-item-${itemId}`)).toContainText("10.4");

      const verifiedResponse = await lab.request.get(
        `/api/lab/worklist?filter=verified&q=${encodeURIComponent(mrn)}`,
      );
      const verified = (await verifiedResponse.json()) as {
        orders: Array<{
          id: string;
          status: string;
          items: Array<{
            results: Array<{ parameter: string; value: string; flag: string; verifiedAt: string | null }>;
          }>;
        }>;
      };
      const order = verified.orders.find((row) => row.id === labOrderId);
      expect(order?.status).toBe("verified");
      const haemoglobin = order?.items[0].results.find((row) => row.parameter === "Haemoglobin");
      expect(haemoglobin).toMatchObject({ value: "10.4", flag: "L" });
      expect(haemoglobin?.verifiedAt).toBeTruthy();
    });

    await test.step("the doctor sees the verified result live and can close the visit", async () => {
      // The doctor's SSE listener reloads the encounter on lab_results_verified.
      const card = doctor.getByTestId(`lab-order-${labOrderId}`);
      await expect(card).toContainText("Verified");
      await expect(card).toContainText("Haemoglobin");
      await expect(card).toContainText("10.4");
      await expect(card).toContainText("12 - 17");
      await expect(card).toContainText("Low");

      await expect(doctor.getByTestId("doctor-outcome")).not.toContainText("still outstanding");
      await expect(doctor.getByTestId("discharge-visit")).toBeEnabled();

      const detailResponse = await doctor.request.get(`/api/doctor/encounter/${encounterId}`);
      expect(detailResponse.status()).toBe(200);
      const detail = (await detailResponse.json()) as {
        labOrders: Array<{
          id: string;
          status: string;
          items: Array<{ results: Array<{ parameter: string; value: string }> }>;
        }>;
      };
      const detailOrder = detail.labOrders.find((row) => row.id === labOrderId);
      expect(detailOrder?.status).toBe("verified");
      expect(detailOrder?.items[0].results).toHaveLength(4);

      await doctor.getByTestId("discharge-visit").click();
      await doctor.getByTestId("outcome-notes").fill("Anaemia workup released, review in one week");
      await doctor.getByTestId("confirm-outcome").click();
      await expect(doctor.getByTestId("doctor-no-selection")).toBeVisible();

      const closedResponse = await doctor.request.get(`/api/doctor/encounter/${encounterId}`);
      const closed = (await closedResponse.json()) as {
        patient: { status: string };
        labOrders: Array<{ id: string; status: string }>;
      };
      expect(closed.patient.status).toBe("discharged");
      expect(closed.labOrders.find((row) => row.id === labOrderId)?.status).toBe("verified");
    });
  } finally {
    await receptionContext.close();
    await triageContext.close();
    await doctorContext.close();
    await labContext.close();
  }
});
