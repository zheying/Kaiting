import { defineConfig } from "@playwright/test";
import path from "node:path";

const report = process.env.E2E_REPORT_DIR ?? "../../artifacts/e2e/manual-prototype-atmosphere";
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["atmosphere.spec.ts", "real-music.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  maxFailures: 1,
  timeout: 30_000,
  globalSetup: "../../scripts/e2e-browser.mjs",
  reporter: [["line"], ["html", { outputFolder: path.join(report, "report"), open: "never" }], ["json", { outputFile: path.join(report, "results.json") }]],
  outputDir: path.join(report, "test-results"),
  use: {
    baseURL: "http://127.0.0.1:4175",
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: "on",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "npm run preview -- --port 4175",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe"
  }
});
