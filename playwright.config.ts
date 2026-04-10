import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/desktop/e2e",
  fullyParallel: false,
  reporter: "list",
  timeout: 30_000,
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  workers: 1,
});
