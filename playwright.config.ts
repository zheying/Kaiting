import { defineConfig } from "@playwright/test";

const reports = process.env.E2E_REPORT_DIR ?? "artifacts/e2e/manual";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./scripts/e2e-browser.mjs",
  outputDir: `${reports}/results`,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 1,
  forbidOnly: true,
  retries: 0,
  maxFailures: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: `${reports}/report.json` }],
    ["junit", { outputFile: `${reports}/junit.xml` }],
    ["html", { outputFolder: `${reports}/html`, open: "never" }]
  ],
  use: {
    browserName: "chromium",
    // 使用 Playwright 管理的独立浏览器，避免启动用户日常使用的 Chrome。
    // 全局预检使用相同通道，验证启动与 AAC 能力；不复用个人 profile。
    channel: "chromium",
    launchOptions: { timeout: 20_000 },
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    reducedMotion: "reduce",
    trace: "on",
    screenshot: "on",
    actionTimeout: 12_000,
    navigationTimeout: 20_000
  }
});
