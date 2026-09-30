import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "artifacts/test-selection");
fs.mkdirSync(output, { recursive: true });
const results = [];
const invoke = (...args) => spawnSync(process.execPath, ["scripts/test.mjs", ...args], {
  cwd: root, encoding: "utf8", timeout: 60_000
});
function check(name, verify) {
  try { verify(); results.push({ name, status: "passed" }); }
  catch (error) { results.push({ name, status: "failed", error: String(error) }); }
}
function preview(...args) {
  const result = invoke(...args, "--list");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function rejects(...args) {
  const result = invoke(...args);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.ok(!result.stdout.includes("RUN  v"), "不应启动 Vitest");
}
function isolatedProject(verify) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-test-selection-"));
  try {
    fs.mkdirSync(path.join(directory, "scripts"));
    for (const file of ["test.mjs", "test-catalog.mjs"]) fs.copyFileSync(path.join(root, "scripts", file), path.join(directory, "scripts", file));
    for (const file of preview("all").files) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.writeFileSync(path.join(directory, file), "// 隔离的命令验收占位文件。\n");
    }
    verify(directory, (...args) => spawnSync(process.execPath, ["scripts/test.mjs", ...args], { cwd: directory, encoding: "utf8" }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

check("默认和只有筛选选项的命令不会执行全量", () => {
  rejects("files"); rejects("files", "-t", "AAC");
  const result = spawnSync("npm", ["test", "--", "--list"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
});
check("精确文件选择、去重和正则转发", () => {
  const result = preview("files", "tests/audio.test.ts", "tests/audio.test.ts", "-t", "AAC|ALAC");
  assert.deepEqual(result.files, ["tests/audio.test.ts"]);
  assert.deepEqual(result.vitestArgs, ["run", "tests/audio.test.ts", "-t", "AAC|ALAC"]);
});
check("拼写错误和无效参数不会退回全量", () => {
  for (const args of [["files", "tests/missing.test.ts"], ["files", "tests"], ["scope", "playbak"],
    ["scope"], ["files", "--scope", "playback"], ["files", "tests/audio.test.ts", "--unknown"],
    ["files", "tests/audio.test.ts", "-t"], ["files", "tests/audio.test.ts", "--passWithNoTests"]]) rejects(...args);
});
check("层级覆盖完整，原型保留且不加入生产播放器范围", () => {
  const unit = preview("unit").files;
  const integration = preview("integration").files;
  const all = preview("all").files;
  assert.equal(unit.filter((file) => integration.includes(file)).length, 0);
  assert.deepEqual([...unit, ...integration].sort(), all);
  assert.deepEqual(preview("prototype").files, ["tests/prototype-accounts.test.ts", "tests/prototype-login-scene.test.ts", "tests/prototype-state.test.ts"]);
  assert.ok(preview("prototype").files.every((file) => all.includes(file)));
  assert.ok(preview("scope", "playback").files.every((file) => !preview("prototype").files.includes(file)));
});
check("多功能选择是单功能集合的去重并集", () => {
  const scopes = ["playback", "playlists"];
  assert.deepEqual(preview("scope", ...scopes).files, [...new Set(scopes.flatMap((scope) => preview("scope", scope).files))].sort());
});
check("CI 包含全量且不能被额外参数缩减", () => {
  const ci = preview("ci");
  assert.deepEqual(ci.files, preview("all").files);
  assert.ok(ci.vitestArgs.includes("--allowOnly=false"));
  assert.ok(ci.vitestArgs.includes("--reporter=junit"));
  rejects("ci", "-t", "AAC"); rejects("all", "tests/audio.test.ts");
});
check("新测试漏登记或登记文件消失时明确失败", () => isolatedProject((directory, call) => {
    fs.writeFileSync(path.join(directory, "tests/unregistered.test.ts"), "// 隔离的新增测试占位。\n");
    fs.unlinkSync(path.join(directory, "tests/audio.test.ts"));
    const result = call("files", "tests/audio.test.ts", "--list");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /未登记：tests\/unregistered.test.ts/);
    assert.match(result.stderr, /已移动或删除：tests\/audio.test.ts/);
}));
check("测试子进程失败码传回调用方", () => isolatedProject((directory, call) => {
  fs.mkdirSync(path.join(directory, "node_modules/vitest"), { recursive: true });
  fs.writeFileSync(path.join(directory, "node_modules/vitest/vitest.mjs"), "process.exit(7);\n");
  assert.equal(call("files", "tests/audio.test.ts").status, 7);
}));
check("CI 缺少 FFmpeg 时提前失败", () => {
  const result = spawnSync(process.execPath, ["scripts/test.mjs", "ci"], {
    cwd: root, env: { ...process.env, PATH: "" }, encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FFmpeg/);
  assert.ok(!result.stdout.includes("RUN  v"));
});
check("实际只执行选中的 unit 和 integration 文件并产出报告", () => {
  const report = "artifacts/test-selection/targeted.json";
  const result = spawnSync("npm", ["test", "--", "tests/audio.test.ts", "tests/playlist-client.test.ts",
    "-t", "audio format policy|playlist browser/server contract", "--reporter=json", `--outputFile=${report}`], {
    cwd: root, encoding: "utf8", timeout: 60_000
  });
  fs.writeFileSync(path.join(output, "targeted.log"), result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const data = JSON.parse(fs.readFileSync(path.join(root, report), "utf8"));
  assert.equal(data.numTotalTests, 7);
  assert.equal(data.numPassedTests, 7);
  assert.equal(data.numPendingTests, 0);
  assert.deepEqual(data.testResults.map((test) => path.basename(test.name)).sort(), ["audio.test.ts", "playlist-client.test.ts"]);
});
check("无匹配用例不会误报通过", () => {
  const result = invoke("files", "tests/audio.test.ts", "-t", "^NO_TEST_SHOULD_MATCH_THIS_NAME$");
  fs.writeFileSync(path.join(output, "no-matching-tests.log"), result.stdout + result.stderr);
  assert.equal(result.status, 1, result.stdout + result.stderr);
});
check("生产功能不隐式包含旧实现，显式 legacy 仍可选择", () => {
  const legacy = preview("scope", "legacy").files;
  for (const scope of ["auth", "ui", "playlists", "playback"]) assert.ok(preview("scope", scope).files.every((file) => !legacy.includes(file)));
  assert.ok(legacy.every((file) => preview("all").files.includes(file)));
});
check("E2E 默认、拼错功能、额外全量筛选均拒绝执行", () => {
  for (const args of [["selected"], ["selected", "playbak"], ["selected", "-g", "播放"], ["all", "-g", "播放"]]) {
    const result = spawnSync(process.execPath, ["scripts/e2e.mjs", ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr); assert.ok(!result.stdout.includes("Running"));
  }
});
check("E2E 文件和多个功能选择精确去重，全量显式包含所有 spec", () => {
  const call = (...args) => {
    const result = spawnSync(process.execPath, ["scripts/e2e.mjs", ...args, "--list"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  assert.deepEqual(call("selected", "auth", "e2e/auth.spec.ts", "playback", "-g", "播放").files, ["e2e/auth.spec.ts", "e2e/playback.spec.ts"]);
  assert.deepEqual(call("all").files, fs.readdirSync(path.join(root, "e2e")).filter((name) => name.endsWith(".spec.ts")).sort().map((name) => `e2e/${name}`));
});
check("E2E 用例名零匹配明确失败且不启动 fixture", () => {
  const result = spawnSync(process.execPath, ["scripts/e2e.mjs", "selected", "auth",
    "--grep", "^NO_TEST_SHOULD_MATCH_THIS_NAME$"], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /No tests found/);
  assert.ok(!result.stdout.includes("build"));
  assert.ok(!result.stdout.includes("浏览器预检"));
  assert.ok(!result.stdout.includes("Running"));
});
check("CI 计划包含类型构建、全部层级和报告，禁止筛选缩减", () => {
  const result = spawnSync(process.execPath, ["scripts/ci.mjs", "--list"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout).stages;
  assert.ok(plan.some(([, args]) => args.join(" ") === "scripts/test.mjs ci"));
  assert.ok(plan.some(([, args]) => args.join(" ") === "scripts/e2e.mjs all"));
  for (const args of [["-t", "AAC"], ["auth"], ["--list", "auth"]]) assert.equal(spawnSync(process.execPath, ["scripts/ci.mjs", ...args], { cwd: root }).status, 1);
});
const report = { generatedAt: new Date().toISOString(), results };
fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify(report, null, 2) + "\n");
for (const result of results) console.log(`${result.status === "passed" ? "通过" : "失败"}：${result.name}${result.error ? `\n${result.error}` : ""}`);
console.log("验收报告：artifacts/test-selection/acceptance.json");
process.exitCode = results.some((result) => result.status === "failed") ? 1 : 0;
