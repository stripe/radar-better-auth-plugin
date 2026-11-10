import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  use: {
    baseURL: "http://localhost:3100",
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "npm run db:migrate && npm run dev -w nextjs-example -- --port 3100",
    url: "http://localhost:3100",
    timeout: 120_000,
    env: {
      ACCOUNT_EVALUATIONS_MODE: "mock",
      ACCOUNT_EVALUATIONS_POLICY: "enforce",
      BETTER_AUTH_URL: "http://localhost:3100",
      BETTER_AUTH_SECRET: "local-browser-test-secret-not-for-production",
      DATABASE_PATH: join(
        tmpdir(),
        `account-evaluations-e2e-${randomUUID()}.db`,
      ),
    },
  },
});
