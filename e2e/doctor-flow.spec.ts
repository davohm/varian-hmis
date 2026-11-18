import { expect, test, type Browser, type Page } from "@playwright/test";

const PASSWORD = "VarianHMIS2026!";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

async function registerPatientWithVisit(page: Page, suffix: string) {
  await page.goto("/reception");
  await expect(page.getByTestId("screen-reception")).toBeVisible();

  await page.getByTestId("patient-first-name").fill(`Consult${suffix}`);
  await page.getByTestId("patient-last-name").fill("Room");
  await page.getByTestId("patient-dob").fill("1979-07-22");
  await page.getByTestId("patient-phone").fill(`07${String(Date.now()).slice(-9)}`);
  await page.getByTestId("start-visit-checkbox").check();
  await page.getByTestId("register-patient").click();

  await expect(page.getByTestId("registration-success")).toContainText(`Consult${suffix}`);
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

  await page.getByTestId("vitals-systolic").fill("122");
  await page.getByTestId("vitals-diastolic").fill("78");
  await page.getByTestId("vitals-heartRate").fill("76");
  await page.getByTestId("vitals-respRate").fill("16");
  await page.getByTestId("vitals-temperature").fill("36.7");
  await page.getByTestId("vitals-spo2").fill("98");
  await page.getByTestId("vitals-weightKg").fill("68");
  await page.getByTestId("vitals-heightCm").fill("172");

  await page.getByTestId("triage-chief-complaint").fill("Recurrent headache for one week");
  await page.getByTestId("triage-comments").fill("No fever, no vomiting, no neck stiffness");
  await page.getByTestId("triage-next-steps").fill("Doctor review and treatment plan");

  await page.getByTestId("record-triage").click();
  await expect(page.getByTestId("triage-success")).toContainText(mrn);
}

test("doctor consults, documents, orders, prescribes and closes the visit", async ({
  browser,
}: {
  browser: Browser;
}) => {
  // The dev server compiles each route (server and client bundles) on first
  // hit; the reception → triage → doctor hand-off touches many cold routes.
  test.slow();

  const receptionContext = await browser.newContext();
  const triageContext = await browser.newContext();
  const doctorContext = await browser.newContext();
  const reception = await receptionContext.newPage();
  const triage = await triageContext.newPage();
  const doctor = await doctorContext.newPage();

  try {
    const mrn = await test.step("reception registers a patient and starts a visit", async () => {
      await signIn(reception, "receptionist@fam.test");
      return registerPatientWithVisit(reception, String(Date.now()).slice(-6));
    });

    await test.step("triage records vitals and hands the patient to the doctor", async () => {
      await signIn(triage, "triage@fam.test");
      await triagePatient(triage, mrn);
    });

    await test.step("doctor opens the consultation", async () => {
      await signIn(doctor, "doctor@fam.test");
      await doctor.goto("/doctor");
      await expect(doctor.getByTestId("screen-doctor")).toBeVisible();
      await expect(doctor.getByTestId("doctor-live-queue")).toBeVisible();

      const queueRow = doctor.locator("[data-testid^='queue-row-']").filter({ hasText: mrn });
      await expect(queueRow).toBeVisible();
      await queueRow.locator("button").click();

      // Selecting the patient starts the consultation and pins the banner.
      await expect(doctor.getByTestId("doctor-patient-banner")).toContainText(mrn);
      await expect(doctor.getByTestId("doctor-triage-summary")).toContainText("122/78");
      await expect(doctor.getByTestId("doctor-patient-banner")).toContainText(
        "Recurrent headache for one week",
      );
    });

    const doctorQueueResponse = await doctor.request.get("/api/queue?department=Doctor");
    expect(doctorQueueResponse.status()).toBe(200);
    const doctorQueue = (await doctorQueueResponse.json()) as {
      entries: Array<{ mrn: string; encounterId: string }>;
    };
    const queued = doctorQueue.entries.find((entry) => entry.mrn === mrn);
    expect(queued, `Doctor queue should hold ${mrn}`).toBeTruthy();
    const encounterId = queued!.encounterId;

    await test.step("doctor documents a signed SOAP note and a primary diagnosis", async () => {
      // A draft is editable, signing locks it.
      await doctor
        .getByTestId("soap-subjective")
        .fill("Headache for one week, worse in the evening");
      await doctor
        .getByTestId("soap-objective")
        .fill("Alert, afebrile, normal neurology, no neck stiffness");
      await doctor.getByTestId("soap-assessment").fill("Tension-type headache");
      await doctor.getByTestId("soap-plan").fill("Analgesia, hydration, review in five days");

      await doctor.getByTestId("save-note").click();
      await expect(doctor.getByText("Draft note saved")).toBeVisible();
      await expect(doctor.getByTestId("soap-subjective")).toBeEditable();

      await doctor.getByTestId("sign-note").click();
      await expect(doctor.getByTestId("doctor-soap")).toContainText("Signed");
      await expect(doctor.getByTestId("doctor-soap")).toContainText("Tension-type headache");
      await expect(doctor.getByTestId("soap-subjective")).toHaveCount(0);

      // ICD-10 coded diagnosis, marked primary.
      await doctor.getByTestId("icd10-search").fill("tension-type headache");
      await doctor.getByTestId("icd10-result-G44.2").click();
      await doctor.getByTestId("icd10-primary").check();
      await doctor.getByTestId("add-diagnosis").click();
      await expect(doctor.getByTestId("diagnosis-row-G44.2")).toContainText("Primary");
      await expect(doctor.getByTestId("diagnosis-row-G44.2")).toContainText("Tension-type headache");
    });

    await test.step("doctor orders a lab test and prescribes a medicine", async () => {
      // The outstanding order keeps the visit open.
      await doctor.getByTestId("order-lab-tests").click();
      await doctor.getByTestId("lab-test-option-FBC").check();
      await doctor.getByTestId("lab-clinical-notes").fill("Baseline haemoglobin before analgesia");
      await doctor.getByTestId("submit-lab-order").click();

      const labOrder = doctor.locator("[data-testid^='lab-order-']").first();
      await expect(labOrder).toContainText("Ordered");
      await expect(labOrder).toContainText("Full Blood Count");
      await expect(doctor.getByTestId("doctor-outcome")).toContainText("still outstanding");
      await expect(doctor.getByTestId("discharge-visit")).toBeDisabled();

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
      await expect(prescription).toContainText("1 tablet");
      await expect(prescription).toContainText("qty 10");
    });

    await test.step("doctor cancels the order and discharges the patient", async () => {
      const labOrder = doctor.locator("[data-testid^='lab-order-']").first();
      await labOrder.locator("button", { hasText: "Cancel order" }).click();
      await expect(labOrder).toContainText("Cancelled");
      await expect(doctor.getByTestId("discharge-visit")).toBeEnabled();

      await doctor.getByTestId("discharge-visit").click();
      await doctor.getByTestId("outcome-notes").fill("Discharged home, return if headache worsens");
      await doctor.getByTestId("confirm-outcome").click();

      await expect(doctor.getByTestId("doctor-no-selection")).toBeVisible();
      await expect(doctor.getByTestId("doctor-patient-banner")).toHaveCount(0);
    });

    const queueResponse = await doctor.request.get("/api/queue?department=Doctor");
    expect(queueResponse.status()).toBe(200);
    const queue = (await queueResponse.json()) as { entries: Array<{ mrn: string }> };
    expect(queue.entries.some((entry) => entry.mrn === mrn)).toBe(false);

    // The encounter detail keeps the record of the closed visit.
    const detailResponse = await doctor.request.get(`/api/doctor/encounter/${encounterId}`);
    expect(detailResponse.status()).toBe(200);
    const detail = (await detailResponse.json()) as {
      patient: { status: string };
      note: { signedAt: string | null } | null;
      diagnoses: Array<{ code: string; isPrimary: boolean }>;
      labOrders: Array<{ status: string }>;
      prescriptions: Array<{ dose: string }>;
    };
    expect(detail.patient.status).toBe("discharged");
    expect(detail.note?.signedAt).toBeTruthy();
    expect(detail.diagnoses).toEqual([
      expect.objectContaining({ code: "G44.2", isPrimary: true }),
    ]);
    expect(detail.labOrders.map((order) => order.status)).toEqual(["cancelled"]);
    expect(detail.prescriptions).toEqual([expect.objectContaining({ dose: "1 tablet" })]);
  } finally {
    await receptionContext.close();
    await triageContext.close();
    await doctorContext.close();
  }
});
