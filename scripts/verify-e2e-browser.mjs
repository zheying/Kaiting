import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "artifacts/browser-isolation");
fs.mkdirSync(output, { recursive: true });
const results = [];
function check(name, verify) {
  try { verify(); results.push({ name, status: "passed" }); }
  catch (error) { results.push({ name, status: "failed", error: String(error) }); }
}
// 用隔离的 Playwright 进程边界观察启动次数，不为了重现故障而让真实浏览器崩溃。
function invoke({ scenario = "success", sandbox = "", channel = "", headed = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-browser-check-"));
  try {
    fs.copyFileSync(path.join(root, "scripts/e2e-browser.mjs"), path.join(directory, "e2e-browser.mjs"));
    const packageDirectory = path.join(directory, "node_modules/@playwright/test");
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
    fs.writeFileSync(path.join(packageDirectory, "index.mjs"), `
      import fs from 'node:fs';
      import path from 'node:path';
      const record = (event) => fs.appendFileSync('calls.jsonl', JSON.stringify(event) + '\\n');
      export const chromium = {
        executablePath: () => path.resolve('testing-browser'),
        async launch(options) {
          record({ type: 'launch', options });
          if (process.env.SCENARIO === 'launch-failed') throw new Error('simulated browser launch failure');
          return {
            version: () => '153.fixture',
            newPage: async () => ({ evaluate: async () => process.env.SCENARIO === 'no-aac' ? '' : 'probably' }),
            close: async () => { record({ type: 'close' }); }
          };
        }
      };
    `);
    if (scenario !== "missing") fs.writeFileSync(path.join(directory, "testing-browser"), "isolated executable fixture");
    fs.writeFileSync(path.join(directory, "run.mjs"), `
      import setup from './e2e-browser.mjs';
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try { await setup({ projects: [{ use: { headless: ${!headed}, channel: 'chromium' } }] }); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    `);
    const reportDirectory = path.join(directory, "report");
    const result = spawnSync(process.execPath, ["run.mjs"], {
      cwd: directory, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, SCENARIO: scenario, CODEX_SANDBOX: sandbox, E2E_BROWSER_CHANNEL: channel, E2E_REPORT_DIR: reportDirectory }
    });
    const callsPath = path.join(directory, "calls.jsonl");
    const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    const report = JSON.parse(fs.readFileSync(path.join(reportDirectory, "browser-preflight.json"), "utf8"));
    return { ...result, calls, report };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

check("macOS seatbelt 在启动浏览器前退出并保留原因", () => {
  const result = invoke({ sandbox: "seatbelt" });
  assert.equal(result.status, 1); assert.deepEqual(result.calls, []);
  assert.equal(result.report.code, "restricted-executor"); assert.match(result.stderr, /获准/);
});
check("缺少测试浏览器时不回退到系统 Chrome", () => {
  const result = invoke({ scenario: "missing" });
  assert.equal(result.status, 1); assert.deepEqual(result.calls, []);
  assert.equal(result.report.code, "browser-not-installed"); assert.match(result.stderr, /playwright install chromium --no-shell/);
});
check("旧系统浏览器通道配置明确拒绝", () => {
  const result = invoke({ channel: "chrome" });
  assert.equal(result.status, 1); assert.deepEqual(result.calls, []);
  assert.equal(result.report.code, "unsupported-channel"); assert.match(result.stderr, /E2E_BROWSER_CHANNEL/);
});
check("启动失败只尝试一次并保存诊断", () => {
  const result = invoke({ scenario: "launch-failed" });
  assert.equal(result.status, 1); assert.equal(result.calls.filter((call) => call.type === "launch").length, 1);
  assert.equal(result.report.code, "browser-launch-failed"); assert.match(result.report.error, /simulated browser launch failure/);
});
check("缺少 AAC 时失败且关闭预检实例", () => {
  const result = invoke({ scenario: "no-aac" });
  assert.equal(result.status, 1); assert.deepEqual(result.calls.map((call) => call.type), ["launch", "close"]);
  assert.equal(result.report.code, "aac-unavailable");
});
for (const headed of [false, true]) check(`${headed ? "有头" : "无头"}预检使用独立通道、有限超时并关闭实例`, () => {
  const result = invoke({ headed });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(result.calls.map((call) => call.type), ["launch", "close"]);
  const options = result.calls[0].options;
  assert.equal(options.channel, "chromium"); assert.equal(options.headless, !headed);
  assert.ok(options.timeout > 0 && options.timeout <= 30_000);
  assert.equal(options.executablePath, undefined); assert.equal(options.userDataDir, undefined);
  assert.equal(result.report.status, "passed"); assert.equal(result.report.version, "153.fixture"); assert.equal(result.report.aac, "probably");
});
check("仅预览 E2E 范围不触发浏览器预检", () => {
  const result = spawnSync(process.execPath, ["scripts/e2e.mjs", "selected", "playback", "--list"], {
    cwd: root, encoding: "utf8", timeout: 10_000, env: { ...process.env, E2E_BROWSER_CHANNEL: "chrome" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).files, ["e2e/playback.spec.ts"]);
});
fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + "\n");
for (const result of results) console.log(`${result.status === "passed" ? "通过" : "失败"}：${result.name}${result.error ? `\n${result.error}` : ""}`);
console.log("浏览器隔离验收：artifacts/browser-isolation/acceptance.json");
process.exitCode = results.some((result) => result.status === "failed") ? 1 : 0;
