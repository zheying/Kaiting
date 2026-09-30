import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const [mode = "selected", ...input] = process.argv.slice(2);
const all = fs.readdirSync(path.join(root, "e2e")).filter((name) => name.endsWith(".spec.ts")).sort();
const help = `请选择 E2E 功能或精确文件，不默认执行全量：\n  npm run test:e2e -- playback [playlists] [--list] [-g '用例名']\n  npm run test:e2e -- e2e/auth.spec.ts\n  npm run test:e2e:all\n可选功能：${all.map((name) => name.replace(".spec.ts", "")).join(", ")}\n真实执行前会构建，报告在 artifacts/e2e/。`;
function execute(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
try {
  if (!["selected", "all"].includes(mode)) throw new Error(`未知 E2E 命令：${mode}`);
  if (input.includes("--help")) { console.log(help); process.exit(0); }
  const list = input.includes("--list"); const args = input.filter((arg) => arg !== "--list");
  const start = args.findIndex((arg) => arg.startsWith("-"));
  const selectors = start < 0 ? args : args.slice(0, start);
  const options = start < 0 ? [] : args.slice(start);
  for (let index = 0; index < options.length; index++) {
    if (options[index] === "--headed") continue;
    if (["-g", "--grep"].includes(options[index]) && options[index + 1] && !options[index + 1].startsWith("--")) { index++; continue; }
    throw new Error(`不支持的 E2E 参数：${options[index]}`);
  }
  if (mode === "all" && args.length) throw new Error("全量入口不接受范围筛选；请使用 test:e2e。");
  if (mode !== "all" && !selectors.length) throw new Error(help);
  const files = mode === "all" ? all.map((name) => `e2e/${name}`) : [...new Set(selectors.map((name) => {
    const file = name.startsWith("e2e/") ? name : `e2e/${name}.spec.ts`;
    if (!all.some((known) => `e2e/${known}` === file)) throw new Error(`未知 E2E 范围：${name}\n${help}`);
    return file;
  }))];
  if (!files.length) throw new Error("没有 E2E 文件，拒绝空跑。");
  const cli = [path.join(root, "node_modules/@playwright/test/cli.js"), "test", ...files, ...options];
  if (list) { console.log(JSON.stringify({ files, command: [process.execPath, ...cli] }, null, 2)); process.exit(0); }
  // Playwright 的 globalSetup 早于用例收集；先只收集一次，避免零匹配也启动浏览器。
  const collection = spawnSync(process.execPath, [...cli, "--list", "--reporter=json"], {
    cwd: root, encoding: "utf8", env: process.env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024
  });
  if (collection.error) throw collection.error;
  const inventory = JSON.parse(collection.stdout);
  const countTests = (suites) => suites.reduce((count, suite) => count + (suite.specs ?? []).reduce((total, spec) => total + spec.tests.length, 0) + countTests(suite.suites ?? []), 0);
  if (collection.status !== 0 || !countTests(inventory.suites ?? [])) {
    throw new Error((inventory.errors ?? []).map((error) => error.message).join("\n") || "No tests found. E2E 筛选没有匹配用例，未启动浏览器。");
  }
  if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 10_000 }).status !== 0) throw new Error("E2E 需要 FFmpeg 来生成独立音频和验证转码。");
  if (process.env.E2E_SKIP_BUILD !== "1") {
    const built = execute("npm", ["run", "build"]); if (built) process.exit(built);
  }
  const reportDirectory = `artifacts/e2e/${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${mode === "all" ? "all" : selectors.map((name) => path.basename(name).replace(".spec.ts", "")).join("-")}`;
  process.env.E2E_REPORT_DIR = reportDirectory;
  fs.mkdirSync(path.join(root, reportDirectory), { recursive: true });
  const fingerprintFiles = ["package.json", "package-lock.json", "playwright.config.ts", "vite.config.ts", "tsconfig.e2e.json",
    ...["src", "e2e", "scripts", "dist"].flatMap((directory) => fs.readdirSync(path.join(root, directory), { recursive: true }).map((file) => `${directory}/${file}`))]
    .filter((file) => fs.statSync(path.join(root, file)).isFile()).sort();
  const sha256 = Object.fromEntries(fingerprintFiles.map((file) => [file, createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")]));
  fs.writeFileSync(path.join(root, reportDirectory, "run.json"), JSON.stringify({ command: process.argv.slice(2), files, node: process.version,
    gitHead: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim(),
    buildSkipped: process.env.E2E_SKIP_BUILD === "1", sha256 }, null, 2));
  console.log(`E2E 证据：${reportDirectory}`);
  process.exitCode = execute(process.execPath, cli);
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
