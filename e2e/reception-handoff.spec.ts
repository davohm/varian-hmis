import { expect, test, type Browser, type Page } from "@playwright/test";

const PASSWORD = "VarianHMIS2026!";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

async function registerPatient(page: Page, suffix: string) {
  await page.goto("/reception");
  await expect(page.getByTestId("screen-reception")).toBeVisible();

  await page.getByTestId("patient-first-name").fill(`Cross${suffix}`);
  await page.getByTestId("patient-last-name").fill("Station");
  await page.getByTestId("patient-dob").fill("1992-05-04");
  await page.getByTestId("patient-phone").fill(`07${String(Date.now()).slice(-9)}`);
  await page.getByTestId("start-visit-checkbox").check();
  await page.getByTestId("register-patient").click();

  await expect(page.getByTestId("registration-success")).toContainText(`Cross${suffix}`);
  const banner = await page.getByTestId("registration-success").innerText();
  const mrn = banner.match(/[A-Z]+-\d{2}-\d{5}/)?.[0];
  expect(mrn, `MRN should be shown in the registration banner: ${banner}`).toBeTruthy();
  return mrn!;
}

test("registering at reception reaches another station's triage queue within 2 seconds", async ({
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
    await signIn(triage, "triage@fam.test");

    await triage.goto("/triage");
    await expect(triage.getByTestId("screen-triage")).toBeVisible();
    await expect(triage.getByTestId("triage-live-queue")).toBeVisible();

    const mrn = await registerPatient(reception, String(Date.now()).slice(-6));
    const registeredAt = Date.now();

    await expect(
      triage.locator("[data-testid^='queue-row-']").filter({ hasText: mrn }),
    ).toBeVisible({ timeout: 2_000 });

    expect(Date.now() - registeredAt).toBeLessThan(2_000);
  } finally {
    await receptionContext.close();
    await triageContext.close();
  }
});
