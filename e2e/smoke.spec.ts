import { expect, test } from "@playwright/test";

test("redirects unauthenticated users to the staff sign-in page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText("Sign in to Varian HMIS")).toBeVisible();
  await expect(page.getByLabel("Work email")).toBeVisible();
});
