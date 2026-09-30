import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { layers, scopes, testPath } from "./test-catalog.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
const [mode = "files", ...input] = process.argv.slice(2);
const help = `请选择要运行的测试（无参数不会运行全量）：
  npm test -- tests/audio.test.ts [tests/media.test.ts] [-t 'AAC|ALAC']
  npm run test:scope -- playback [playlists] [--list]
  npm run test:unit / test:integration / test:prototype
  npm run test:list                         查看功能范围
  npm run test:inventory                    仅收集用例清单，不执行测试
  npm run test:all                          显式运行全部 unit/integration
  npm run test:e2e -- playback              按功能验证真实浏览器流程
  npm run test:e2e:all                      显式运行全部 E2E
  npm run test:ci                           类型/构建 + 全部 unit/integration/E2E + 报告
  npm run test:selection                    验收选择命令（只运行 2 个产品测试文件）
可选：--list 仅预览，-t / --testNamePattern、--reporter、--outputFile、--watch。
范围与验证记录见 docs/testing/test-implementation-2026-09-28.md。`;
function fail(message) { throw new Error(message); }
function run(args, options = {}) {
  const result = spawnSync(process.execPath, [vitest, ...args], { cwd: root, stdio: "inherit", ...options });
  if (result.error) fail(result.error.message);
  if (result.signal) fail(`Vitest 被信号 ${result.signal} 终止`);
  return result;
}
function main() {
  if (input.includes("--help")) { console.log(help); return 0; }
  const registered = Object.values(layers).flat().map(testPath).sort();
  const discovered = fs.readdirSync(path.join(root, "tests"), { recursive: true })
    .filter((file) => file.endsWith(".test.ts")).map((file) => `tests/${file.replaceAll(path.sep, "/")}`).sort();
  const missing = discovered.filter((file) => !registered.includes(file));
  const stale = registered.filter((file) => !discovered.includes(file));
  if (missing.length || stale.length || new Set(registered).size !== registered.length) {
    fail(`测试清单不一致，请更新 scripts/test-catalog.mjs。\n未登记：${missing.join(", ")}\n已移动或删除：${stale.join(", ")}\n每个文件只能登记在一个层级。`);
  }
  for (const scope of Object.values(scopes)) {
    if (scope.tests.some((name) => !registered.includes(testPath(name)))) fail("功能范围引用了未登记的测试。");
  }
  if (mode === "list") {
    if (input.length) fail(`test:list 不接受筛选参数；预览功能请使用 test:scope -- 范围 --list。`);
    console.log(help);
    for (const [name, scope] of Object.entries(scopes)) console.log(`${name} (${scope.tests.length} 文件)：${scope.description}`);
    console.log(`unit：${layers.unit.length} 文件；integration：${layers.integration.length} 文件；产品浏览器 E2E：${fs.readdirSync(path.join(root, "e2e")).filter((file) => file.endsWith(".spec.ts")).length} 文件（test:e2e）。`);
    return 0;
  }
  const listOnly = input.includes("--list");
  const args = input.filter((arg) => arg !== "--list");
  const optionStart = args.findIndex((arg) => arg.startsWith("-"));
  const selectors = optionStart < 0 ? args : args.slice(0, optionStart);
  const options = optionStart < 0 ? [] : args.slice(optionStart);
  let pattern;
  for (let index = 0; index < options.length; index++) {
    const [name, ...inline] = options[index].split("=");
    if (name === "--watch" && !inline.length) continue;
    if (!["-t", "--testNamePattern", "--reporter", "--outputFile"].includes(name)) fail(`不支持的参数：${name}\n${help}`);
    const value = inline.length ? inline.join("=") : options[++index];
    if (!value || value.startsWith("--")) fail(`参数 ${name} 缺少值。`);
    if (name === "-t" || name === "--testNamePattern") pattern = value;
  }
  let files;
  if (mode === "files") {
    if (!selectors.length) fail(help);
    files = selectors.map((file) => path.relative(root, path.resolve(root, file)).replaceAll(path.sep, "/"));
    for (const file of files) if (!registered.includes(file)) fail(`不是已登记的精确测试文件：${file}\n${help}`);
  } else if (mode === "scope") {
    if (!selectors.length) fail(help);
    files = selectors.flatMap((name) => {
      if (!Object.hasOwn(scopes, name)) fail(`未知功能范围：${name}；可选：${Object.keys(scopes).join(", ")}`);
      return scopes[name].tests.map(testPath);
    });
  } else {
    if (selectors.length) fail(`此入口不接收文件或功能名；请使用 npm test 或 test:scope。`);
    if (Object.hasOwn(layers, mode)) files = layers[mode].map(testPath);
    else if (mode === "prototype") files = scopes.prototype.tests.map(testPath);
    else if (["all", "ci", "inventory"].includes(mode)) {
      if (options.length) fail(`${mode} 不接受额外筛选参数；局部执行请使用 npm test 或 test:scope。`);
      files = registered;
    } else fail(`未知命令：${mode}\n${help}`);
  }
  files = [...new Set(files)].sort();
  if (!files.length) fail("没有选中测试，不执行。");
  const ciOptions = ["--allowOnly=false", "--reporter=default", "--reporter=junit", "--outputFile.junit=artifacts/tests/ci.xml"];
  const vitestArgs = mode === "inventory"
    ? ["list", "--json=artifacts/tests/inventory.json"]
    : ["run", ...files, ...(mode === "ci" ? ciOptions : options)];
  if (listOnly) { console.log(JSON.stringify({ mode, files, vitestArgs }, null, 2)); return 0; }
  if (mode === "ci") {
    if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 10_000 }).status !== 0) {
      fail("CI 需要 FFmpeg；缺失时会跳过真实 ALAC 转码测试，因此中止全量验收。请安装后重试。");
    }
  }
  // Vitest 对 -t 零匹配可能按全跳过成功处理；先收集该文件范围，避免假通过。
  if (pattern !== undefined) {
    const collected = run(["list", ...files, "-t", pattern, "--json"], { stdio: "pipe", encoding: "utf8" });
    if (collected.status !== 0) fail(collected.stderr || collected.stdout || "用例收集失败。");
    if (!JSON.parse(collected.stdout).length) fail(`选定文件中没有匹配的用例：${pattern}`);
  }
  if (mode === "ci" || mode === "inventory") fs.mkdirSync(path.join(root, "artifacts/tests"), { recursive: true });
  console.log(`${mode === "inventory" ? "仅收集清单" : "执行测试"}：${files.length} 个文件。`);
  const status = run(vitestArgs).status ?? 1;
  if (status !== 0 || mode !== "inventory") return status;
  const e2e = spawnSync(process.execPath, [path.join(root, "node_modules/@playwright/test/cli.js"), "test", "--list", "--reporter=json"], { cwd: root, encoding: "utf8" });
  if (e2e.status !== 0) fail(e2e.stderr || e2e.stdout || "E2E 清单收集失败");
  const inventory = JSON.parse(e2e.stdout);
  fs.writeFileSync(path.join(root, "artifacts/tests/e2e-inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
  console.log("E2E 清单：artifacts/tests/e2e-inventory.json（只收集，不启动浏览器或服务）。");
  return 0;
}
try { process.exitCode = main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
