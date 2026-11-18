import { expect, test } from "@playwright/test";

const PASSWORD = "VarianHMIS2026!";

const ROLES = [
  {
    email: "receptionist@fam.test",
    navLabel: "Reception",
    screenTestId: "screen-reception",
    path: /\/reception$/,
    slug: "reception",
  },
  {
    email: "triage@fam.test",
    navLabel: "Triage",
    screenTestId: "screen-triage",
    path: /\/triage$/,
    slug: "triage",
  },
  {
    email: "doctor@fam.test",
    navLabel: "Consultation",
    screenTestId: "screen-doctor",
    path: /\/doctor$/,
    slug: "doctor",
  },
  {
    email: "lab@fam.test",
    navLabel: "Laboratory",
    screenTestId: "screen-lab",
    path: /\/lab$/,
    slug: "lab",
  },
  {
    email: "pharmacist@fam.test",
    navLabel: "Pharmacy",
    screenTestId: "screen-pharmacy",
    path: /\/pharmacy$/,
    slug: "pharmacy",
  },
  {
    email: "cashier@fam.test",
    navLabel: "Cashier",
    screenTestId: "screen-cashier",
    path: /\/cashier$/,
    slug: "cashier",
  },
  {
    email: "admin@fam.test",
    navLabel: "Administration",
    screenTestId: "screen-admin",
    path: /\/admin$/,
    slug: "admin",
  },
] as const;

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

for (const role of ROLES) {
  test(`${role.slug} sees only its workspace and cannot call admin actions`, async ({ page }) => {
    await signIn(page, role.email);

    await expect(page).toHaveURL(role.path);
    await expect(page.getByTestId(role.screenTestId)).toBeVisible();
    await expect(page.getByTestId("connection-status")).toContainText("Online");

    const nav = page.getByRole("navigation", { name: "Role navigation" });
    await expect(nav.getByRole("link", { name: role.navLabel })).toBeVisible();
    for (const other of ROLES.filter((item) => item.navLabel !== role.navLabel)) {
      await expect(nav.getByRole("link", { name: other.navLabel })).toHaveCount(0);
    }

    const guardedEndpoints = [
      { method: "GET" as const, path: "/api/admin/staff", adminStatus: 200 },
      { method: "GET" as const, path: "/api/admin/overview", adminStatus: 200 },
      { method: "GET" as const, path: "/api/admin/audit?limit=5", adminStatus: 200 },
      // An unknown command still returns 400 for an admin: the guard passed and
      // the command allow-list rejected it.
      { method: "POST" as const, path: "/api/admin/commands", adminStatus: 400 },
    ];

    for (const endpoint of guardedEndpoints) {
      const response = await page.request.fetch(endpoint.path, {
        method: endpoint.method,
        data: endpoint.method === "POST" ? { command: "unknown" } : undefined,
      });
      expect(response.status(), `${endpoint.method} ${endpoint.path}`).toBe(
        role.slug === "admin" ? endpoint.adminStatus : 403,
      );
    }

    if (role.slug !== "admin") {
      await page.goto("/admin");
      await expect(page.getByTestId("screen-forbidden")).toBeVisible();
    }
  });
}

test("failed sign-in is written to the audit log", async ({ page }) => {
  await signIn(page, "admin@fam.test");
  await expect(page).toHaveURL(/\/admin$/);

  const failed = await page.request.post("/api/auth/sign-in/email", {
    // The request shares the browser context's session cookie, so better-auth
    // enforces its CSRF origin check; without this header it returns
    // MISSING_OR_NULL_ORIGIN and never reaches the sign-in audit.
    headers: { origin: "http://127.0.0.1:3000" },
    data: { email: "admin@fam.test", password: "wrong-password-long" },
  });
  expect(failed.status()).toBe(401);

  const auditResponse = await page.request.get("/api/admin/audit");
  expect(auditResponse.status()).toBe(200);
  const body = (await auditResponse.json()) as {
    events: Array<{ action: string; details?: { email?: string } }>;
  };
  const recent = body.events.map(
    (event) => `${event.action}:${event.details?.email ?? ""}`,
  );
  expect(recent, `Recent audit events: ${recent.join(", ")}`).toContain(
    "auth.sign_in.failed:admin@fam.test",
  );
});
