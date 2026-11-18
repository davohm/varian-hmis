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

    const response = await page.request.get("/api/admin/staff");
    if (role.slug === "admin") {
      expect(response.status()).toBe(200);
    } else {
      expect(response.status()).toBe(403);
      await page.goto("/admin");
      await expect(page.getByTestId("screen-forbidden")).toBeVisible();
    }
  });
}

test("failed sign-in is written to the audit log", async ({ page }) => {
  await signIn(page, "admin@fam.test");
  await expect(page).toHaveURL(/\/admin$/);

  const failed = await page.request.post("/api/auth/sign-in/email", {
    data: { email: "admin@fam.test", password: "wrong-password-long" },
  });
  expect(failed.status()).toBeGreaterThanOrEqual(400);

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
