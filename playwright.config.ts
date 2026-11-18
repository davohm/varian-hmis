import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  // The dev server compiles routes on demand; too many concurrent workers
  // make the first sign-in navigation exceed the assertion timeout.
  workers: 2,
  timeout: 90_000,
  // The dev server compiles each route on first hit; a cold route can take
  // ~10s, so assertions need more room than a built app would.
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: process.platform === "win32" ? "npm.cmd run dev" : "npm run dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
