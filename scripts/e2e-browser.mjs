import fs from "node:fs";
import path from "node:path";

function unavailable(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 启动能力属于环境前提；只检查一次，不让测试 worker 轮流重试崩溃的浏览器。 */
export async function checkE2EBrowser({ headless = true, reportDirectory = process.env.E2E_REPORT_DIR ?? "artifacts/e2e/manual" } = {}) {
  fs.mkdirSync(reportDirectory, { recursive: true });
  const report = { checkedAt: new Date().toISOString(), channel: "chromium", headless, status: "failed" };
  try {
    if (process.env.E2E_BROWSER_CHANNEL && process.env.E2E_BROWSER_CHANNEL !== "chromium") {
      throw unavailable("unsupported-channel", "E2E 只使用 Playwright 管理的测试浏览器。请移除 E2E_BROWSER_CHANNEL；不会回退到系统 Chrome。");
    }
    // 此环境中应用注册会直接 SIGABRT，不能先启动一次碰运气，也不能清除标志来绕过执行边界。
    if (process.platform === "darwin" && process.env.CODEX_SANDBOX === "seatbelt") {
      throw unavailable("restricted-executor", "当前 macOS seatbelt 执行环境无法安全启动 E2E 浏览器，已在启动前停止。请使用获准的浏览器执行环境或普通终端运行同一命令；不要清除环境标志重试。");
    }
    const { chromium } = await import("@playwright/test");
    report.executable = chromium.executablePath();
    if (!fs.existsSync(report.executable)) {
      throw unavailable("browser-not-installed", "缺少独立测试浏览器，请先运行 npx playwright install chromium --no-shell；Linux CI 可加 --with-deps。不会安装或启动系统 Chrome。");
    }
    let browser;
    try {
      browser = await chromium.launch({ channel: "chromium", headless, timeout: 20_000 });
      report.version = browser.version();
      const page = await browser.newPage();
      report.aac = await page.evaluate(() => document.createElement("audio").canPlayType('audio/mp4; codecs="mp4a.40.2"'));
      if (!report.aac) throw unavailable("aac-unavailable", "独立测试浏览器缺少 AAC 解码能力，已停止验收；不能跳过直传播放测试。");
    } finally {
      await browser?.close();
    }
    report.status = "passed";
    console.log(`浏览器预检通过：独立 ${report.channel} ${report.version}，AAC ${report.aac}。`);
    return report;
  } catch (error) {
    report.code = error.code ?? "browser-launch-failed";
    report.error = error instanceof Error ? error.message : String(error);
    if (error.code) throw error;
    throw unavailable(report.code, "独立测试浏览器预检失败，已停止后续用例且不会重试或启动系统 Chrome。详情见 browser-preflight.json。");
  } finally {
    fs.writeFileSync(path.join(reportDirectory, "browser-preflight.json"), JSON.stringify(report, null, 2) + "\n");
  }
}

export default async function setup(config) {
  await checkE2EBrowser({ headless: config.projects[0]?.use.headless ?? true });
}
