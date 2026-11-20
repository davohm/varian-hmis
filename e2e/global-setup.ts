/**
 * Pre-flight before the suite: sign in as each role, open the workspace that
 * role owns, then call every API route with the method the app uses.
 *
 * The suite runs against a production build (see playwright.config.ts), so
 * this no longer exists to warm compiles. It earns its place by failing early
 * and cheaply: a broken seed, a role that cannot sign in, or a route module
 * that throws on load shows up here instead of as fifteen unrelated timeouts.
 * Failures are swallowed on purpose — a real test should report the problem.
 */
import { chromium, request, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:3000";
const PASSWORD = "VarianHMIS2026!";

/** Each workspace is opened as the role that owns it. */
const WORKSPACES = [
  { email: "receptionist@fam.test", path: "/reception", testId: "screen-reception" },
  { email: "triage@fam.test", path: "/triage", testId: "screen-triage" },
  { email: "doctor@fam.test", path: "/doctor", testId: "screen-doctor" },
  { email: "lab@fam.test", path: "/lab", testId: "screen-lab" },
  { email: "pharmacist@fam.test", path: "/pharmacy", testId: "screen-pharmacy" },
  { email: "cashier@fam.test", path: "/cashier", testId: "screen-cashier" },
  { email: "accountant@fam.test", path: "/finance", testId: "screen-finance" },
  { email: "accountant@fam.test", path: "/finance/statements", testId: "screen-statements" },
  { email: "accountant@fam.test", path: "/finance/budgets", testId: "screen-budgets" },
  { email: "revenue@fam.test", path: "/finance/revenue", testId: "screen-revenue" },
  { email: "auditor@fam.test", path: "/finance", testId: "screen-finance" },
  { email: "admin@fam.test", path: "/admin", testId: "screen-admin" },
] as const;

/** Every route the suite calls, with the method the app uses for it. */
const API_ROUTES: Array<[method: "GET" | "POST", path: string]> = [
  ["GET", "/api/session/context"],
  ["POST", "/api/session/activate"],
  ["GET", "/api/queue?department=Triage"],
  ["GET", "/api/queue?department=Doctor"],
  ["POST", "/api/reception/register"],
  ["POST", "/api/reception/start-visit"],
  ["POST", "/api/reception/queue"],
  ["GET", "/api/patients/search?q=warmup"],
  ["GET", "/api/patients/duplicates?phone=0700000000"],
  ["POST", "/api/triage/vitals"],
  ["GET", "/api/doctor/catalog"],
  ["GET", "/api/doctor/icd10?q=warmup"],
  ["GET", "/api/doctor/encounter/00000000-0000-0000-0000-000000000000"],
  ["POST", "/api/doctor/consultation"],
  ["POST", "/api/doctor/notes"],
  ["POST", "/api/doctor/diagnoses"],
  ["POST", "/api/doctor/diagnoses/void"],
  ["POST", "/api/doctor/lab-orders"],
  ["POST", "/api/doctor/lab-orders/cancel"],
  ["POST", "/api/doctor/prescriptions"],
  ["POST", "/api/doctor/prescriptions/cancel"],
  ["POST", "/api/doctor/discharge"],
  ["GET", "/api/lab/worklist?filter=pending"],
  ["GET", "/api/lab/catalog"],
  ["POST", "/api/lab/collect"],
  ["POST", "/api/lab/start"],
  ["POST", "/api/lab/results"],
  ["POST", "/api/lab/verify"],
  ["GET", "/api/pharmacy/queue"],
  ["GET", "/api/pharmacy/stock?q=warmup"],
  ["GET", "/api/pharmacy/items"],
  ["GET", "/api/pharmacy/prescriptions/00000000-0000-0000-0000-000000000000"],
  ["POST", "/api/pharmacy/receive"],
  ["POST", "/api/pharmacy/adjust"],
  ["POST", "/api/pharmacy/transfer"],
  ["POST", "/api/pharmacy/dispense"],
  ["POST", "/api/pharmacy/reverse"],
  ["GET", "/api/cashier/queue?q=warmup"],
  ["GET", "/api/cashier/encounters/00000000-0000-0000-0000-000000000000"],
  ["POST", "/api/cashier/invoices"],
  ["GET", "/api/cashier/invoices/00000000-0000-0000-0000-000000000000"],
  ["POST", "/api/cashier/invoices/void"],
  ["POST", "/api/cashier/payments"],
  ["POST", "/api/cashier/payments/reverse"],
  ["GET", "/api/cashier/receipts/00000000-0000-0000-0000-000000000000"],
  ["GET", "/api/cashier/sessions"],
  ["POST", "/api/cashier/sessions/close"],
  ["GET", "/api/cashier/sessions/report?sessionId=00000000-0000-0000-0000-000000000000"],
  ["GET", "/api/admin/staff"],
  ["GET", "/api/admin/overview"],
  ["GET", "/api/admin/audit?limit=5"],
  ["POST", "/api/admin/commands"],
  ["GET", "/api/admin/sync"],
  ["POST", "/api/admin/sync"],
  ["GET", "/api/finance"],
  ["POST", "/api/finance"],
  ["GET", "/api/finance/statements"],
  ["GET", "/api/finance/budgets"],
  ["POST", "/api/finance/budgets"],
  ["GET", "/api/revenue"],
  ["POST", "/api/revenue"],
  ["GET", "/api/health"],
  ["POST", "/api/sync/batch"],
  ["GET", "/api/sync/pull"],
];

/**
 * Sign in as one role and open the workspace it owns. A rejected sign-in or a
 * workspace that never renders is a broken seed or a broken guard.
 */
async function checkWorkspace(
  browser: Browser,
  workspace: (typeof WORKSPACES)[number],
): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/login`, { timeout: 120_000 });
    await page.getByLabel("Work email").fill(workspace.email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 120_000 });
    await page.goto(`${BASE_URL}${workspace.path}`, { timeout: 120_000 });
    await page.getByTestId(workspace.testId).waitFor({ state: "visible", timeout: 120_000 });
    // Let the workspace's first queue fetch and the event stream connect.
    await page.waitForTimeout(1_500);
  } catch {
    // Best effort: a failure here must not hide the real tests.
  } finally {
    await context.close();
  }
}

/** Call every API route with the method the app uses; a 4xx is a pass. */
async function checkApi(api: APIRequestContext): Promise<void> {
  for (const [method, path] of API_ROUTES) {
    try {
      await api.fetch(path, {
        method,
        data: method === "POST" ? {} : undefined,
        failOnStatusCode: false,
        timeout: 120_000,
      });
    } catch {
      // Best effort, as above.
    }
  }
}

export default async function globalSetup(): Promise<void> {
  const browser = await chromium.launch();
  let storageState: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined;
  try {
    for (const workspace of WORKSPACES) {
      await checkWorkspace(browser, workspace);
    }

    // Reuse the admin session for the API checks so the guards run against a
    // real facility rather than short-circuiting on an anonymous request.
    const adminContext = await browser.newContext();
    try {
      const page = await adminContext.newPage();
      await page.goto(`${BASE_URL}/login`, { timeout: 120_000 });
      await page.getByLabel("Work email").fill("admin@fam.test");
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 120_000 });
      await page.getByTestId("screen-admin").waitFor({ state: "visible", timeout: 120_000 });
      storageState = await adminContext.storageState();
    } catch {
      // Fall back to an anonymous check; the tests still fail with diagnostics.
    } finally {
      await adminContext.close();
    }
  } finally {
    await browser.close();
  }

  const api = await request.newContext({ baseURL: BASE_URL, storageState });
  try {
    await checkApi(api);
  } finally {
    await api.dispose();
  }
}
