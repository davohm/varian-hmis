import { expect, test } from "@playwright/test";

test("redirects unauthenticated users to the staff sign-in page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in to your account" })).toBeVisible();
  await expect(page.getByLabel("Work email")).toBeVisible();
});
