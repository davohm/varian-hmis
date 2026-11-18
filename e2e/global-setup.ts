/**
 * The dev server compiles routes on demand. Without a warm-up, the first
 * requests from parallel Playwright workers queue behind a large client
 * component compile and can exceed the 10s assertion timeout. Warming the
 * modules once in global setup keeps the suite deterministic.
 */
const BASE_URL = "http://127.0.0.1:3000";

const PAGES = [
  "/login",
  "/",
  "/reception",
  "/triage",
  "/doctor",
  "/lab",
  "/pharmacy",
  "/cashier",
  "/admin",
];

const API_ROUTES = [
  "/api/session/context",
  "/api/session/activate",
  "/api/queue?department=Triage",
  "/api/queue?department=Doctor",
  "/api/reception/register",
  "/api/reception/start-visit",
  "/api/reception/queue",
  "/api/patients/search?q=warmup",
  "/api/patients/duplicates?phone=0700000000",
  "/api/triage/vitals",
  "/api/admin/staff",
  "/api/admin/audit",
  "/api/auth/session",
];

async function warm(path: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    // Warm-up is best effort: the tests still fail with their own diagnostics.
  }
}

export default async function globalSetup(): Promise<void> {
  for (const path of [...PAGES, ...API_ROUTES]) {
    await warm(path);
  }
}
