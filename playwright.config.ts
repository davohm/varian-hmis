import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  // `next dev` compiles routes on demand, and it exits with RESTART_EXIT_CODE
  // once used heap passes 80% of the V8 limit (see
  // next/dist/server/lib/start-server.js). A full suite compiles every route,
  // so the dev server restarted mid-run and tests hit ECONNREFUSED. The suite
  // therefore runs against a production build, which has no on-demand compile
  // and no memory watchdog.
  workers: 1,
  timeout: 90_000,
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
    command:
      process.platform === "win32"
        ? "npm.cmd run build && npm.cmd run start"
        : "npm run build && npm run start",
    url: "http://127.0.0.1:3000",
    // Reusing a server is convenient while iterating on one spec, but a reused
    // `next dev` process brings back the memory watchdog and the compile
    // stalls, so a full run should start from a free port.
    reuseExistingServer: !process.env.CI,
    // The build itself takes about a minute before the server can answer.
    timeout: 300_000,
    // Better Auth throttles /sign-in to 3 requests per 10s in production and
    // the suite signs in as six roles back to back. Only the test server turns
    // the limiter off; see src/server/auth/auth.ts.
    env: { AUTH_RATE_LIMIT: "off" },
  },
});
