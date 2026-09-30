import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkE2EBrowser } from "./e2e-browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const stages = [
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "build"]],
  ["npm", ["run", "test:selection"]],
  ["npm", ["run", "test:browser"]],
  [process.execPath, ["scripts/test.mjs", "ci"]],
  [process.execPath, ["scripts/e2e.mjs", "all"]],
  ["git", ["diff", "--check"]]
];
const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === "--list") { console.log(JSON.stringify({ stages }, null, 2)); process.exit(0); }
  if (args.length) throw new Error("CI 全量入口不接受筛选参数。预览用 --list，局部测试用 test:scope / test:e2e。");
  if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 10_000 }).status !== 0) throw new Error("CI 必须安装 FFmpeg，拒绝跳过真实转码。");
  await checkE2EBrowser({ reportDirectory: path.join(root, "artifacts/tests/ci-browser") });
  fs.mkdirSync(path.join(root, "artifacts/tests"), { recursive: true });
  const results = [];
  for (const [command, stageArgs] of stages) {
    const result = spawnSync(command, stageArgs, { cwd: root, stdio: "inherit", env: { ...process.env, CI: "true", E2E_SKIP_BUILD: "1" } });
    results.push({ command: [command, ...stageArgs], status: result.status, signal: result.signal, error: result.error?.message });
    fs.writeFileSync(path.join(root, "artifacts/tests/ci-stages.json"), JSON.stringify(results, null, 2) + "\n");
    if (result.error || result.signal || result.status !== 0) { process.exitCode = result.status || 1; break; }
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
