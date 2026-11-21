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

  await page.getByTestId("patient-first-name").fill(`Vitals${suffix}`);
  await page.getByTestId("patient-last-name").fill("Station");
  await page.getByTestId("patient-dob").fill("1988-03-14");
  await page.getByTestId("patient-phone").fill(`07${String(Date.now()).slice(-9)}`);
  await page.getByTestId("start-visit-checkbox").check();
  await page.getByTestId("register-patient").click();
  await page.getByTestId("registration-consent-confirm").click();

  await expect(page.getByTestId("registration-success")).toContainText(`Vitals${suffix}`);
  const banner = await page.getByTestId("registration-success").innerText();
  const mrn = banner.match(/[A-Z]+-\d{2}-\d{5}/)?.[0];
  expect(mrn, `MRN should be shown in the registration banner: ${banner}`).toBeTruthy();
  return mrn!;
}

test("triage records vitals, auto-flags them and hands the patient to the doctor queue", async ({
  browser,
}: {
  browser: Browser;
}) => {
  const receptionContext = await browser.newContext();
  const triageContext = await browser.newContext();
  const reception = await receptionContext.newPage();
  const triage = await triageContext.newPage();

  try {
    await signIn(reception, "receptionist@fam.test");
    const mrn = await registerPatientWithVisit(reception, String(Date.now()).slice(-6));

    await signIn(triage, "triage@fam.test");
    await triage.goto("/triage");
    await expect(triage.getByTestId("screen-triage")).toBeVisible();
    await expect(triage.getByTestId("triage-live-queue")).toBeVisible();

    const queueRow = triage
      .locator("[data-testid^='queue-row-']")
      .filter({ hasText: mrn });
    await expect(queueRow).toBeVisible({ timeout: 10_000 });
    await queueRow.locator("button").click();

    await expect(triage.getByTestId("triage-patient-banner")).toContainText(mrn);

    await triage.getByTestId("vitals-systolic").fill("150");
    await triage.getByTestId("vitals-diastolic").fill("95");
    await triage.getByTestId("vitals-heartRate").fill("88");
    await triage.getByTestId("vitals-respRate").fill("18");
    await triage.getByTestId("vitals-temperature").fill("37.0");
    await triage.getByTestId("vitals-spo2").fill("97");
    await triage.getByTestId("vitals-weightKg").fill("70");
    await triage.getByTestId("vitals-heightCm").fill("175");

    await expect(triage.getByTestId("vitals-bmi")).toHaveText("22.9");
    await expect(triage.getByTestId("vital-flag-systolic")).toContainText("Out of range high");
    await expect(triage.getByTestId("triage-suggested-category")).toContainText("priority");
    await expect(triage.getByTestId("category-yellow")).toHaveAttribute("aria-checked", "true");

    await triage.getByTestId("triage-chief-complaint").fill("Raised blood pressure at check-in");
    await triage.getByTestId("triage-comments").fill("Recheck after 15 minutes of rest");
    await triage.getByTestId("triage-next-steps").fill("Doctor review before any procedure");

    await triage.getByTestId("record-triage").click();
    await expect(triage.getByTestId("triage-success")).toContainText(mrn);
    await expect(triage.getByTestId("triage-success")).toContainText("priority");

    const doctorResponse = await triage.request.get("/api/queue?department=Doctor");
    expect(doctorResponse.status()).toBe(200);
    const doctorQueue = (await doctorResponse.json()) as {
      entries: Array<{ mrn: string; priority: string; status: string }>;
    };
    expect(doctorQueue.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ mrn, priority: "yellow", status: "waiting" })]),
    );

    const triageResponse = await triage.request.get("/api/queue?department=Triage");
    const triageQueue = (await triageResponse.json()) as { entries: Array<{ mrn: string }> };
    expect(triageQueue.entries.some((entry) => entry.mrn === mrn)).toBe(false);
  } finally {
    await receptionContext.close();
    await triageContext.close();
  }
});
