import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

const PASSWORD = "VarianHMIS2026!";

interface RevenueData {
  payers: Array<{ id: string; name: string }>;
  contracts: Array<{ id: string; contractNo: string; benefitCount: number }>;
  preAuthorizations: Array<{ id: string; authNo: string; reference: string | null; status: string }>;
  claims: Array<{ id: string; claimNo: string; payerId: string; status: string }>;
  remittances: Array<{ id: string; claimId: string; remittanceNo: string }>;
  denials: Array<{ id: string; claimId: string; reason: string; status: string }>;
}

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("[data-testid^='screen-']").first()).toBeVisible();
}

async function openRevenue(page: Page, email: string) {
  await signIn(page, email);
  await page.goto("/finance/revenue");
  await expect(page.getByTestId("screen-revenue")).toBeVisible();
}

async function createPayer(page: Page, name: string): Promise<string> {
  const response = await page.request.post("/api/revenue", {
    data: {
      command: "createPayer",
      input: { idempotencyKey: randomUUID(), code: `E2E${randomUUID().slice(0, 8).toUpperCase()}`, name, kind: "insurer" },
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { result: { payerId: string } };
  return body.result.payerId;
}

async function readRevenue(page: Page): Promise<RevenueData> {
  const response = await page.request.get("/api/revenue");
  expect(response.status()).toBe(200);
  return (await response.json()) as RevenueData;
}

/** Registers a patient with an open visit through the reception workspace. */
async function registerVisit(browser: Browser, suffix: string): Promise<string> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signIn(page, "receptionist@fam.test");
    await page.goto("/reception");
    await expect(page.getByTestId("screen-reception")).toBeVisible();

    await page.getByTestId("patient-first-name").fill(`Rev${suffix}`);
    await page.getByTestId("patient-last-name").fill("Payer");
    await page.getByTestId("patient-dob").fill("1985-04-12");
    await page.getByTestId("patient-phone").fill(`07${String(Date.now()).slice(-9)}`);
    await page.getByTestId("start-visit-checkbox").check();
    await page.getByTestId("register-patient").click();
    await page.getByTestId("registration-consent-confirm").click();

    const banner = await page.getByTestId("registration-success").innerText();
    const mrn = banner.match(/[A-Z]+-\d{2}-\d{5}/)?.[0];
    expect(mrn, `MRN should be shown in the registration banner: ${banner}`).toBeTruthy();

    const search = await context.request.get(`/api/patients/search?q=${encodeURIComponent(mrn!)}`);
    expect(search.status()).toBe(200);
    const patients = ((await search.json()) as { patients: Array<{ id: string; mrn: string }> }).patients;
    const patient = patients.find((item) => item.mrn === mrn);
    expect(patient, `Patient ${mrn} should be searchable after registration`).toBeTruthy();

    // Revenue commands refuse to share patient data until payer-sharing consent
    // exists. Reception captures treatment consent only, so seed the payer
    // consent through the guarded privacy admin command.
    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, "admin@fam.test");
      const consent = await adminContext.request.post("/api/admin/privacy", {
        data: {
          command: "recordConsent",
          input: {
            idempotencyKey: randomUUID(),
            patientId: patient!.id,
            consentType: "payer_sharing",
            consentVersion: "v1",
            granted: true,
            grantedAt: new Date().toISOString(),
            grantedBy: `Rev${suffix} Payer`,
            source: "e2e",
          },
        },
      });
      expect(consent.status()).toBe(201);
    } finally {
      await adminContext.close();
    }

    return mrn!;
  } finally {
    await context.close();
  }
}

async function selectPatient(page: Page, pickerTestId: string, mrn: string) {
  await page.getByTestId(`${pickerTestId}-search`).fill(mrn);
  const select = page.getByTestId(`${pickerTestId}-select`);
  await expect(select).toBeEnabled();
  const options = await select.locator("option").allTextContents();
  const label = options.find((option) => option.includes(mrn));
  expect(label, `Patient ${mrn} should appear in the search results`).toBeTruthy();
  await select.selectOption({ label: label! });
}

test("revenue officer manages payers, contracts and benefits", async ({ page }) => {
  await openRevenue(page, "revenue@fam.test");
  await expect(page.getByTestId("revenue-kpi-open-claims")).toBeVisible();
  await page.getByTestId("revenue-tab-payers").click();
  await expect(page.getByTestId("revenue-payers-panel")).toBeVisible();

  const payerName = `E2E Payer ${randomUUID().slice(0, 8)}`;
  const payerCode = `E2EP${randomUUID().slice(0, 8).toUpperCase()}`;
  await page.getByRole("button", { name: "New payer" }).click();
  const payerForm = page.getByTestId("revenue-payer-form");
  await payerForm.getByLabel("Code").fill(payerCode);
  await payerForm.getByLabel("Name", { exact: true }).fill(payerName);
  await payerForm.getByLabel("Kind").selectOption("insurer");
  await payerForm.getByRole("button", { name: "Create payer" }).click();
  await expect(page.getByTestId(`revenue-payer-${payerCode}`)).toContainText(payerName);

  const contractNo = `E2EC${randomUUID().slice(0, 8).toUpperCase()}`;
  await page.getByRole("button", { name: "New contract" }).click();
  const contractForm = page.getByTestId("revenue-contract-form");
  await contractForm.getByLabel("Payer").selectOption({ label: payerName });
  await contractForm.getByLabel("Contract number").fill(contractNo);
  await contractForm.getByLabel("Start date").fill("2026-01-01");
  await contractForm.getByLabel("End date").fill("2026-12-31");
  await contractForm.getByRole("button", { name: "Create contract" }).click();
  await expect(page.getByTestId(`revenue-contract-${contractNo}`)).toContainText(payerName);

  await page.getByTestId(`revenue-add-benefit-${contractNo}`).click();
  const benefitForm = page.getByTestId("revenue-benefit-form");
  await benefitForm.getByLabel("Benefit category").fill("Outpatient consultation");
  await benefitForm.getByLabel("Copay percent").fill("10");
  await benefitForm.getByRole("button", { name: "Add benefit" }).click();
  await expect
    .poll(async () => {
      const data = await readRevenue(page);
      return data.contracts.find((item) => item.contractNo === contractNo)?.benefitCount ?? 0;
    })
    .toBe(1);

  await page.getByTestId(`revenue-toggle-payer-${payerCode}`).click();
  await expect(page.getByTestId(`revenue-payer-${payerCode}`)).toContainText("Inactive");
  await page.getByTestId(`revenue-toggle-payer-${payerCode}`).click();
  await expect(page.getByTestId(`revenue-payer-${payerCode}`)).toContainText("Active");
});

test("auditor reads revenue data but cannot write", async ({ page }) => {
  await openRevenue(page, "auditor@fam.test");
  await expect(page.getByTestId("revenue-kpi-outstanding")).toBeVisible();
  await page.getByTestId("revenue-tab-payers").click();
  await expect(page.getByRole("button", { name: "New payer" })).toHaveCount(0);
  await expect(page.getByTestId("revenue-payers-table")).toBeVisible();

  const read = await page.request.get("/api/revenue");
  expect(read.status()).toBe(200);

  const write = await page.request.post("/api/revenue", {
    data: {
      command: "createPayer",
      input: { idempotencyKey: randomUUID(), code: `DENY${randomUUID().slice(0, 6)}`, name: "Denied", kind: "cash" },
    },
  });
  expect(write.status()).toBe(403);
});

test("revenue officer requests and approves a pre-authorisation", async ({ browser, page }) => {
  const mrn = await registerVisit(browser, randomUUID().slice(0, 6));
  const payerName = `E2E Auth Payer ${randomUUID().slice(0, 6)}`;
  await openRevenue(page, "revenue@fam.test");
  await createPayer(page, payerName);
  await page.reload();
  await expect(page.getByTestId("screen-revenue")).toBeVisible();
  await page.getByTestId("revenue-tab-preauth").click();

  const reference = `AUTH-${randomUUID().slice(0, 8)}`;
  await page.getByRole("button", { name: "Request pre-authorisation" }).click();
  const form = page.getByTestId("revenue-preauth-form");
  const payerSelect = form.getByLabel("Payer");
  await expect(payerSelect.locator("option", { hasText: payerName })).toHaveCount(1);
  await payerSelect.selectOption({ label: payerName });
  await selectPatient(page, "revenue-preauth", mrn);
  await form.getByLabel("Requested amount").fill("4500.00");
  await form.getByLabel("Reference").fill(reference);
  await form.getByRole("button", { name: "Request authorisation" }).click();
  await expect(page.getByTestId("revenue-preauth-form")).toHaveCount(0);

  const auth = (await readRevenue(page)).preAuthorizations.find((item) => item.reference === reference);
  expect(auth).toBeTruthy();
  await expect(page.getByTestId(`revenue-preauth-${auth!.authNo}`)).toContainText("requested");

  await page.getByTestId(`revenue-decide-preauth-${auth!.authNo}`).click();
  const decisionForm = page.getByTestId("revenue-preauth-decision-form");
  await decisionForm.getByLabel("Approved amount").fill("4000.00");
  await decisionForm.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId(`revenue-preauth-${auth!.authNo}`)).toContainText("approved");
});

test("revenue officer works a claim through submission, payment and denial resolution", async ({
  browser,
  page,
}) => {
  const mrn = await registerVisit(browser, randomUUID().slice(0, 6));
  const payerName = `E2E Claim Payer ${randomUUID().slice(0, 6)}`;
  await openRevenue(page, "revenue@fam.test");
  const payerId = await createPayer(page, payerName);
  await page.reload();
  await expect(page.getByTestId("screen-revenue")).toBeVisible();
  await page.getByTestId("revenue-tab-claims").click();

  await page.getByRole("button", { name: "New claim" }).click();
  const form = page.getByTestId("revenue-claim-form");
  const payerSelect = form.getByLabel("Payer");
  await expect(payerSelect.locator("option", { hasText: payerName })).toHaveCount(1);
  await payerSelect.selectOption({ label: payerName });
  await selectPatient(page, "revenue-claim", mrn);
  await form.getByLabel("Encounter").selectOption({ index: 1 });
  await form.getByLabel("Line description").fill("E2E specialist consultation");
  await form.getByLabel("Claim amount").fill("1250.00");
  await form.getByRole("button", { name: "Create claim" }).click();
  await expect(page.getByTestId("revenue-claim-form")).toHaveCount(0);

  const data = await readRevenue(page);
  const claim = data.claims.find((item) => item.payerId === payerId);
  expect(claim).toBeTruthy();
  await expect(page.getByTestId(`revenue-claim-${claim!.claimNo}`)).toContainText("draft");

  await page.getByTestId(`revenue-open-claim-${claim!.claimNo}`).click();
  await expect(page.getByTestId("revenue-claim-detail")).toContainText(claim!.claimNo);

  const transition = page.getByTestId("revenue-claim-transition-form");
  await transition.getByLabel("Next status").selectOption("submitted");
  await transition.getByRole("button", { name: "Apply status" }).click();
  await expect
    .poll(async () => (await readRevenue(page)).claims.find((item) => item.id === claim!.id)?.status)
    .toBe("submitted");

  await transition.getByLabel("Next status").selectOption("accepted");
  await transition.getByLabel("Approved amount").fill("1250.00");
  await transition.getByRole("button", { name: "Apply status" }).click();
  await expect
    .poll(async () => (await readRevenue(page)).claims.find((item) => item.id === claim!.id)?.status)
    .toBe("accepted");

  await page.getByTestId("revenue-record-remittance").click();
  const remittanceForm = page.getByTestId("revenue-remittance-form");
  await remittanceForm.getByLabel("Remittance amount").fill("1250.00");
  await remittanceForm.getByLabel("Remittance reference").fill("E2E-REM");
  await remittanceForm.getByRole("button", { name: "Save remittance" }).click();
  await expect
    .poll(async () => (await readRevenue(page)).remittances.some((item) => item.claimId === claim!.id))
    .toBe(true);

  await page.getByTestId("revenue-record-denial").click();
  const denialForm = page.getByTestId("revenue-denial-form");
  await denialForm.getByLabel("Denial reason").fill("E2E coding review");
  await denialForm.getByRole("button", { name: "Save denial" }).click();
  await expect(page.getByTestId("revenue-claim-denials-table")).toContainText("E2E coding review");

  await page.getByTestId("revenue-tab-denials").click();
  const denial = (await readRevenue(page)).denials.find(
    (item) => item.claimId === claim!.id && item.reason === "E2E coding review",
  );
  expect(denial).toBeTruthy();
  await page.getByTestId(`revenue-resolve-denial-${denial!.id}`).click();
  const resolutionForm = page.getByTestId("revenue-denial-resolution-form");
  await resolutionForm.getByLabel("Resolution", { exact: true }).selectOption("overturned");
  await resolutionForm.getByRole("button", { name: "Save resolution" }).click();
  await expect(page.getByTestId(`revenue-denial-${denial!.id}`)).toContainText("overturned");
});
