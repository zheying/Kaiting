import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(root, "../..");
const args = process.argv.slice(2);
const originalArgs = [...args];
const realMusic = args.includes("--real-music");
if (realMusic) args.splice(args.indexOf("--real-music"), 1);
const spec = realMusic ? "real-music.spec.ts" : "atmosphere.spec.ts";
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const reuseIndex = args.indexOf("--reuse-build");
const reuseFile = reuseIndex >= 0 ? args.splice(reuseIndex, 2)[1] : null;
const listing = args.includes("--list");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const report = path.join(repository, "artifacts/e2e", `${stamp}-prototype-atmosphere`);
const cli = path.join(repository, "node_modules/@playwright/test/cli.js");
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function tree(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? tree(file) : [file];
  }).sort();
}
const fingerprint = (directories) => Object.fromEntries(directories.flatMap(tree).map((file) => [path.relative(repository, file), hash(file)]));
async function run(command, commandArgs, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, env: { ...process.env, ...(!realMusic ? { PROTOTYPE_MUSIC_ROOT: "" } : {}), PROTOTYPE_DATA_DIR: path.join(report, "music-cache"), E2E_REPORT_DIR: report }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { process.stdout.write(chunk); if (log) fs.appendFileSync(log, chunk); });
    child.stderr.on("data", (chunk) => { process.stderr.write(chunk); if (log) fs.appendFileSync(log, chunk); });
    child.on("error", reject); child.on("close", (code) => resolve(code ?? 1));
  });
}
if (listing) {
  process.exitCode = await run(process.execPath, [cli, "test", "--config", "playwright.config.ts", spec, ...args]);
} else {
  fs.mkdirSync(report, { recursive: true });
  const log = path.join(report, "service-and-test.log");
  const source = fingerprint([path.join(root, "src"), path.join(root, "public"), path.join(root, "e2e"), path.join(root, "server")]);
  source["prototypes/listening-room/vite.config.ts"] = hash(path.join(root, "vite.config.ts"));
  const primaryBefore = fingerprint([path.join(repository, "src")]);
  const record = {
    startedAt: new Date().toISOString(), scope: "prototype-atmosphere",
    command: `npm --prefix prototypes/listening-room run test:atmosphere${originalArgs.length ? ` -- ${originalArgs.map(shellQuote).join(" ")}` : ""}`,
    source, build: {}, originalDemoAudioHash: hash(path.join(root, "public/audio/atmosphere-demo.wav")),
    productionAPI: "not-used", database: "not-used", musicLibrary: realMusic ? "read-only-user-authorized" : "not-used",
    primarySourceUnchanged: null, status: "running"
  };
  const save = () => fs.writeFileSync(path.join(report, "run.json"), JSON.stringify(record, null, 2) + "\n");
  save();
  let code = 0;
  if (reuseFile) {
    const previous = JSON.parse(fs.readFileSync(path.resolve(repository, reuseFile), "utf8"));
    const productionSource = (all) => Object.fromEntries(Object.entries(all).filter(([file]) => /prototypes\/listening-room\/((src|public|server)\/|vite\.config\.ts)/.test(file)));
    if (JSON.stringify(productionSource(source)) !== JSON.stringify(productionSource(previous.source)) || JSON.stringify(fingerprint([path.join(root, "dist")])) !== JSON.stringify(previous.build)) {
      throw new Error("源码或构建指纹发生变化，不能复用旧生产构建。");
    }
    record.reusedBuild = reuseFile;
    console.log("复用同一源码的已验证生产构建。");
  } else code = await run("npm", ["run", "build"], log);
  if (code === 0) {
    record.build = fingerprint([path.join(root, "dist")]); save();
    code = await run(process.execPath, [cli, "test", "--config", "playwright.config.ts", spec, ...args], log);
  }
  record.primarySourceUnchanged = JSON.stringify(primaryBefore) === JSON.stringify(fingerprint([path.join(repository, "src")]));
  record.demoAudioUnchanged = record.originalDemoAudioHash === hash(path.join(root, "public/audio/atmosphere-demo.wav"));
  record.finishedAt = new Date().toISOString(); record.status = code === 0 && record.primarySourceUnchanged && record.demoAudioUnchanged ? "passed" : "failed";
  save();
  console.log(`验证产物：${path.relative(repository, report)}`);
  process.exitCode = record.status === "passed" ? 0 : code || 1;
}
