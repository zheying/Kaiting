import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { spawnSync } from "node:child_process";
import { loadEnv, createServer } from "vite";
import { createMusicLibrary, fileHash } from "../server/music-library.js";
import { musicPlugin } from "../server/music-plugin.js";
import { lightingLooks, type PreparedMusic, type MusicCatalog } from "../src/lighting-program.js";
import snapshot from "../src/library.json" with { type: "json" };
import { observeBeats, beatObservation, resetBeatObservation, brightest } from "./beat-observation.js";

test.use({ video: { mode: "on", size: { width: 1280, height: 800 } } });

type ProbeWindow = Window & { liveProbe: { nonzero: number; gain: GainNode | null } };
type RigObservation = { frames: number; origin: number[]; maxDisplacement: number; directionChanges: number; previousDirections: number[]; drift: { frame: number; light: number; displacement: number }[] };
type RigWindow = Window & { rigObservation: RigObservation };
const representative = [
  { id: "0c805c4d054724cbe0f66669", title: "二人の時間の始まり", kind: "quiet" },
  { id: "d8cd560eb9b07fb0e963b831", title: "Nameless Name", kind: "rock" },
  { id: "4bb42fd006edab652d6d3133", title: "OCTOPATH TRAVELER II メインテーマ", kind: "orchestra" }
];
const addedLooks = ["duet", "rain", "afterglow", "horizon", "lattice", "searchlights"];
const drumTrack = { id: "c31f53049e8d99a6428409f0", title: "四足のアルス/グーラ" };
const root = process.env.PROTOTYPE_MUSIC_ROOT ?? loadEnv("production", process.cwd(), "PROTOTYPE_").PROTOTYPE_MUSIC_ROOT;
const privateRoot = process.env.E2E_REPORT_DIR!;
const library = createMusicLibrary(root ?? "", path.join(privateRoot, "audit-cache"));
const evidence = new WeakMap<Page, { requests: string[]; exceptions: string[]; console: string[] }>();
let beforeHashes: Record<string, string> = {};
let sourceFiles: Record<string, string> = {};
let beforeManifest: Record<string, [number, number]> = {};
async function manifest(directory: string, base = directory): Promise<Record<string, [number, number]>> {
  const entries: Record<string, [number, number]> = {};
  for (const item of await fsp.readdir(directory, { withFileTypes: true })) {
    if (item.name.startsWith(".") || item.isSymbolicLink()) continue;
    const file = path.join(directory, item.name);
    if (item.isDirectory()) Object.assign(entries, await manifest(file, base));
    else if (item.isFile()) { const stat = await fsp.stat(file); entries[path.relative(base, file)] = [stat.size, stat.mtimeMs]; }
  }
  return entries;
}
test.beforeAll(async () => {
  test.setTimeout(180_000);
  if (!root) throw new Error("真实曲目验收需要本地 PROTOTYPE_MUSIC_ROOT 配置。");
  beforeManifest = await manifest(root);
  const catalog = await library.catalog();
  expect(catalog.tracks.length).toBeGreaterThan(0);
  for (const track of [...representative, drumTrack]) {
    const source = await library.source(track.id);
    sourceFiles[track.id] = source.file; beforeHashes[track.id] = await fileHash(source.file);
  }
  fs.writeFileSync(path.join(privateRoot, "library-before.json"), JSON.stringify({ hashes: beforeHashes, manifest: beforeManifest }, null, 2));
});
test.afterAll(async () => {
  const afterHashes: Record<string, string> = {};
  for (const [id, file] of Object.entries(sourceFiles)) afterHashes[id] = await fileHash(file);
  const afterManifest = root ? await manifest(root) : {};
  const unchanged = JSON.stringify(beforeManifest) === JSON.stringify(afterManifest) && JSON.stringify(beforeHashes) === JSON.stringify(afterHashes);
  fs.writeFileSync(path.join(privateRoot, "library-readonly-audit.json"), JSON.stringify({ unchanged, beforeHashes, afterHashes, fileCount: Object.keys(afterManifest).length, manifestUnchanged: JSON.stringify(beforeManifest) === JSON.stringify(afterManifest) }, null, 2));
  expect(unchanged).toBe(true);
});
test.beforeEach(async ({ page }) => {
  const log = { requests: [] as string[], exceptions: [] as string[], console: [] as string[] };
  evidence.set(page, log);
  page.on("request", (request) => log.requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  page.on("pageerror", (error) => log.exceptions.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") log.console.push(message.text()); });
  await page.addInitScript(() => {
    const probe = { nonzero: 0, gain: null as GainNode | null };
    (window as unknown as ProbeWindow).liveProbe = probe;
    const read = AnalyserNode.prototype.getByteFrequencyData;
    AnalyserNode.prototype.getByteFrequencyData = function (values) { read.call(this, values); if (Math.max(...values) > 0) probe.nonzero++; };
    const create = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function () { const gain = create.call(this); probe.gain = gain; return gain; };
  });
});
test.afterEach(async ({ page }, info) => {
  const observations = await page.locator("audio").evaluateAll((items) => items.map((node) => {
    const audio = node as HTMLAudioElement;
    return { src: audio.currentSrc, duration: audio.duration, currentTime: audio.currentTime, paused: audio.paused, error: audio.error?.code ?? null };
  })).catch(() => []);
  fs.writeFileSync(info.outputPath("media-and-requests.json"), JSON.stringify({ status: info.status, observations, ...evidence.get(page) }, null, 2));
  expect(evidence.get(page)?.exceptions).toEqual([]);
  if (!info.title.includes("故障")) expect(evidence.get(page)?.console).toEqual([]);
});
const sound = (page: Page) => page.evaluate(() => (window as unknown as ProbeWindow).liveProbe.nonzero);
const media = (page: Page) => page.locator("audio").evaluate((node) => { const a = node as HTMLAudioElement; return { src: a.currentSrc, time: a.currentTime, duration: a.duration, paused: a.paused }; });
async function enter(page: Page) {
  await page.goto("/#/playing");
  await page.getByRole("button", { name: "进入氛围模式", exact: true }).click();
  await expect(page.getByRole("button", { name: "选择真实曲目", exact: true })).toBeVisible({ timeout: 90_000 });
}
async function choose(page: Page, title: string) {
  await page.getByRole("button", { name: "选择真实曲目", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索真实曲目" }).fill(title);
  await page.getByRole("button", { name: `播放真实曲目 ${title}`, exact: true }).click();
}
async function seek(page: Page, seconds: number) {
  // 操作实际进度滑杆，浏览器产生 input/change；不写媒体状态。
  const range = page.getByRole("slider", { name: "氛围播放进度", exact: true });
  await range.focus();
  await range.fill(String(Math.floor(seconds)));
  await range.press("Tab");
  await expect.poll(async () => Math.abs((await media(page)).time - Math.floor(seconds))).toBeLessThan(1.5);
}

test.describe("鼓点现场", () => {
  test("四足のアルス真实起音带动灯组，自动编排与手机灯位保持正确", async ({ page }, info) => {
    test.setTimeout(120_000);
    await observeBeats(page);
    await enter(page);
    await choose(page, drumTrack.title);
    await expect.poll(async () => (await media(page)).paused, { timeout: 90_000 }).toBe(false);
    await expect.poll(() => sound(page)).toBeGreaterThan(5);
    const summaries = [];
    for (const [name, start, end] of [["rhythm", 34, 42], ["release", 96, 104], ["mobile", 66, 71]] as const) {
      if (name === "mobile") await page.setViewportSize({ width: 393, height: 852 });
      await seek(page, start);
      await page.waitForTimeout(700);
      await resetBeatObservation(page, true);
      await expect.poll(async () => (await media(page)).time, { timeout: 15_000 }).toBeGreaterThan(end);
      const observed = await beatObservation(page);
      const samples = observed.samples;
      const rises = samples.filter((sample, i) => i > 0 && sample.wall - samples[i - 1].wall < 150 && brightest(sample) > brightest(samples[i - 1]) * 1.35);
      const origin = samples[0]?.origins;
      const maxDisplacement = Math.max(...samples.flatMap((f) => f.origins.map((value, i) => Math.abs(value - origin[i]))));
      const renderedBrightness = async (data: string) => {
        const { channels } = await sharp(Buffer.from(data.split(",")[1], "base64")).stats();
        return channels[0].mean * .2126 + channels[1].mean * .7152 + channels[2].mean * .0722;
      };
      const imageContrast = await renderedBrightness(observed.peak) / await renderedBrightness(observed.rest);
      const summary = { name, start, end, frames: samples.length, rapidRises: rises.map((f) => f.time), maxDisplacement, imageContrast };
      summaries.push(summary);
      fs.writeFileSync(info.outputPath(`${name}-audio-light-observation.json`), JSON.stringify({ summary, samples }, null, 2));
      for (const [phase, data] of [["peak", observed.peak], ["rest", observed.rest]]) fs.writeFileSync(info.outputPath(`${name}-${phase}.png`), Buffer.from(data.split(",")[1], "base64"));
      await page.screenshot({ path: info.outputPath(`${name}-stage.png`) });
      await expect(page.locator(".atmosphere-mode")).toHaveAttribute("data-theme", "auto");
      expect(samples.length).toBeGreaterThan(50);
      expect(samples.some((f) => f.rms > .02)).toBe(true);
      expect(rises.length).toBeGreaterThanOrEqual(4);
      expect(maxDisplacement).toBe(0);
      // 检查实际渲染像素，避免灯具数值变化却被过亮的底光吞掉。
      expect(imageContrast).toBeGreaterThan(1.4);
    }
    fs.writeFileSync(info.outputPath("drum-track-summary.json"), JSON.stringify({ track: drumTrack, summaries }, null, 2));
    await page.mouse.move(30, 30);
    await page.getByRole("button", { name: "氛围暂停", exact: true }).click();
  });
});

test("灯具安装坐标在全部灯光模式、音乐调度和手机投影中保持固定", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  // 观察提交给真实 WebGL 的坐标，不修改灯光、媒体或应用内部状态。
  await page.addInitScript(() => {
    const observation: RigObservation = { frames: 0, origin: [], maxDisplacement: 0, directionChanges: 0, previousDirections: [], drift: [] };
    (window as unknown as RigWindow).rigObservation = observation;
    const names = new WeakMap<WebGLUniformLocation, string>();
    const locate = WebGLRenderingContext.prototype.getUniformLocation;
    WebGLRenderingContext.prototype.getUniformLocation = function (program, name) {
      const location = locate.call(this, program, name);
      if (location) names.set(location, name);
      return location;
    };
    const submit = WebGLRenderingContext.prototype.uniform4fv;
    WebGLRenderingContext.prototype.uniform4fv = function (location, values) {
      submit.call(this, location, values);
      const name = location ? names.get(location) : "";
      const data = Array.from(values);
      if (name === "sources[0]") {
        observation.frames++;
        if (!observation.origin.length) observation.origin = data.filter((_, i) => i % 4 !== 3);
        for (let i = 0; i < data.length / 4; i++) {
          const displacement = Math.hypot(...[0, 1, 2].map((axis) => data[i * 4 + axis] - observation.origin[i * 3 + axis]));
          observation.maxDisplacement = Math.max(observation.maxDisplacement, displacement);
          if (displacement > .00001 && observation.drift.length < 20) observation.drift.push({ frame: observation.frames, light: i, displacement });
        }
      }
      if (name === "directions[0]") {
        if (observation.previousDirections.length && data.some((v, i) => i % 4 !== 3 && Math.abs(v - observation.previousDirections[i]) > .00001)) observation.directionChanges++;
        observation.previousDirections = data;
      }
    };
  });
  await enter(page);
  await choose(page, representative[1].title);
  await expect.poll(async () => (await media(page)).paused, { timeout: 90_000 }).toBe(false);
  await expect.poll(() => sound(page)).toBeGreaterThan(5);
  const read = () => page.evaluate(() => (window as unknown as RigWindow).rigObservation);
  const samples: { mode: string; frames: number; maxDisplacement: number }[] = [];
  for (const look of lightingLooks) {
    await page.getByRole("button", { name: "灯光编排", exact: true }).click();
    const before = (await read()).frames;
    await page.getByRole("button", { name: look.name, exact: true }).click();
    await expect(page.locator(".atmosphere-mode")).toHaveAttribute("data-lighting-look", look.id);
    await expect.poll(async () => (await read()).frames).toBeGreaterThan(before + 8);
    const observation = await read();
    samples.push({ mode: look.id, frames: observation.frames, maxDisplacement: observation.maxDisplacement });
    if (look.id === "orbit" || look.id === "tunnel" || addedLooks.includes(look.id)) {
      await page.screenshot({ path: info.outputPath(`${look.id}-transition-desktop.png`) });
      await page.waitForTimeout(1600);
      await page.screenshot({ path: info.outputPath(`${look.id}-settled-desktop.png`) });
    }
  }
  const response = await request.get(`/__prototype/music/prepare/${representative[1].id}`);
  const prepared = await response.json() as PreparedMusic;
  await page.getByRole("button", { name: "跟随音乐", exact: true }).click();
  for (const cue of prepared.program!.cues.slice(1, 4)) {
    await seek(page, cue.start + 1);
    await expect(page.locator(".atmosphere-mode")).toHaveAttribute("data-lighting-look", cue.look);
  }
  await page.setViewportSize({ width: 393, height: 852 });
  for (const look of lightingLooks.filter((item) => addedLooks.includes(item.id))) {
    await page.getByRole("button", { name: "灯光编排", exact: true }).click();
    await expect(page.locator(".av-look-grid > button")).toHaveCount(18);
    await page.getByRole("button", { name: look.name, exact: true }).click();
    await expect(page.locator(".atmosphere-mode")).toHaveAttribute("data-lighting-look", look.id);
    await page.waitForTimeout(1600);
    await page.screenshot({ path: info.outputPath(`${look.id}-mobile.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(393);
  }
  await page.getByRole("button", { name: "灯光编排", exact: true }).click();
  await page.getByRole("button", { name: "环形游弋", exact: true }).click();
  await page.waitForTimeout(1600);
  await page.screenshot({ path: info.outputPath("fixed-rig-mobile.png") });
  const observation = await read();
  fs.writeFileSync(info.outputPath("fixed-rig-observation.json"), JSON.stringify({ ...observation, samples }, null, 2));
  expect(observation.frames).toBeGreaterThan(100);
  expect(observation.origin).toHaveLength(72);
  expect(observation.directionChanges).toBeGreaterThan(20);
  expect(observation.maxDisplacement).toBeLessThan(.00001);
});

test("真实三曲按声音调度灯光，跳转与播放时间一致，十八种灯光可选", async ({ page, request }, info) => {
  test.setTimeout(180_000);
  await enter(page);
  const programs: PreparedMusic[] = [];
  for (const track of representative) {
    const response = await request.get(`/__prototype/music/prepare/${track.id}`, { timeout: 120_000 });
    expect(response.ok()).toBe(true);
    const prepared = await response.json() as PreparedMusic;
    programs.push(prepared);
    expect(prepared.track.id).toBe(track.id); expect(prepared.track.codec).toBe("ALAC");
    expect(prepared.sourceHash).toBe(beforeHashes[track.id]); expect(prepared.program).not.toBeNull();
    expect(prepared.program!.version).toBe(4);
    const cues = prepared.program!.cues;
    expect(new Set(cues.map((cue) => cue.look)).size).toBeGreaterThan(2);
    await choose(page, track.title);
    await expect.poll(async () => (await media(page)).src, { timeout: 90_000 }).toContain(`/audio/${track.id}`);
    await expect.poll(async () => (await media(page)).paused).toBe(false);
    const beforeSound = await sound(page);
    await expect.poll(() => sound(page)).toBeGreaterThan(beforeSound + 4);
    expect((await media(page)).duration).toBeCloseTo(prepared.track.duration, 0);
    await expect(page.locator(".atmosphere-mode")).toHaveAttribute("data-source", "library");
    await expect(page.getByText("非本曲音频", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "氛围暂停", exact: true }).click();
    const samples = [cues[1], [...cues].sort((a, b) => b.energy - a.energy)[0], cues[cues.length - 2]];
    for (const [index, cue] of samples.entries()) {
      await seek(page, Math.min(cue.end - .2, cue.start + 1));
      await expect(page.locator(".atmosphere-mode")).toHaveAttribute("data-lighting-look", cue.look);
      await expect(page.locator(".av-theme-caption")).toContainText(cue.reason);
      await page.screenshot({ path: info.outputPath(`${track.kind}-cue-${index}-${cue.look}.png`) });
    }
    await page.getByRole("button", { name: "氛围播放", exact: true }).click();
    const start = (await media(page)).time;
    await expect.poll(async () => (await media(page)).time).toBeGreaterThan(start + .4);
    const actual = await media(page);
    expect(Math.abs(Number(await page.getByLabel("氛围播放进度", { exact: true }).inputValue()) - actual.time)).toBeLessThan(1);
    await page.getByRole("button", { name: "氛围暂停", exact: true }).click();
  }
  expect(JSON.stringify(programs[0].program!.cues)).not.toBe(JSON.stringify(programs[1].program!.cues));
  const scheduledLooks = new Set(programs.flatMap((item) => item.program!.cues.map((cue) => cue.look)));
  for (const look of addedLooks) expect(scheduledLooks.has(look as typeof lightingLooks[number]["id"])).toBe(true);
  expect(programs[0].program!.cues.some((cue) => ["horizon", "lattice", "burst"].includes(cue.look))).toBe(false);
  fs.writeFileSync(info.outputPath("three-track-programs.json"), JSON.stringify(programs, null, 2));
  await page.getByRole("button", { name: "灯光编排", exact: true }).click();
  await expect(page.locator(".av-look-grid > button")).toHaveCount(18);
  await page.screenshot({ path: info.outputPath("eighteen-lighting-looks.png") });
  await page.keyboard.press("Escape");
  const frames = new Set<string>();
  for (const look of lightingLooks) {
    await page.getByRole("button", { name: "灯光编排", exact: true }).click();
    await page.getByRole("button", { name: look.name, exact: true }).click();
    await expect(page.locator(".atmosphere-mode")).toHaveAttribute("data-lighting-look", look.id);
    const screenshot = await page.locator(".av-visual").screenshot({ mask: [page.locator(".av-hud"), page.locator(".av-wake-hint")] });
    frames.add(screenshot.toString("base64"));
    fs.writeFileSync(info.outputPath(`look-${look.id}.png`), screenshot);
  }
  expect(frames.size).toBe(18);
  await page.getByRole("button", { name: "跟随音乐", exact: true }).click();
  await seek(page, 30);
  const progress = page.getByRole("slider", { name: "氛围播放进度", exact: true });
  const box = (await progress.boundingBox())!;
  await page.mouse.move(box.x + box.width * .4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height / 2, { steps: 8 });
  const preview = Number(await progress.inputValue());
  expect(preview).toBeGreaterThan(60);
  expect((await media(page)).time).toBeCloseTo(30, 0);
  await page.screenshot({ path: info.outputPath("real-seek-before-release.png") });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await media(page)).time - preview)).toBeLessThan(1.5);
  await seek(page, 30);
  await page.getByRole("button", { name: "氛围播放", exact: true }).click();
  await page.getByRole("button", { name: "氛围静音", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as ProbeWindow).liveProbe.gain?.gain.value ?? -1)).toBeLessThan(.001);
  const continued = await sound(page);
  await expect.poll(() => sound(page)).toBeGreaterThan(continued + 2);
  await page.getByRole("button", { name: "氛围恢复音量", exact: true }).click();
  await page.getByRole("button", { name: "氛围待播清单", exact: true }).click();
  await page.getByRole("complementary", { name: "氛围待播面板" }).getByRole("button", { name: "顺序播放，点击切换列表循环", exact: true }).click();
  await page.getByRole("complementary", { name: "氛围待播面板" }).getByRole("button", { name: "列表循环，点击切换单曲循环", exact: true }).click();
  await page.getByRole("button", { name: "收起待播清单", exact: true }).click();
  await seek(page, programs[2].track.duration - 2);
  await expect.poll(async () => (await media(page)).time, { timeout: 10_000 }).toBeLessThan(3);
  await expect.poll(async () => (await media(page)).paused).toBe(false);
  expect((await media(page)).src).toContain(`/audio/${representative[2].id}`);
  await page.getByRole("button", { name: "氛围待播清单", exact: true }).click();
  await page.getByRole("complementary", { name: "氛围待播面板" }).getByRole("button", { name: "单曲循环，点击切换顺序播放", exact: true }).click();
  await page.getByRole("button", { name: "收起待播清单", exact: true }).click();
  const old = await page.locator(".av-now h1").innerText();
  await seek(page, programs[2].track.duration - 2);
  await expect(page.locator(".av-now h1")).not.toHaveText(old, { timeout: 15_000 });
  await expect.poll(async () => (await media(page)).paused, { timeout: 90_000 }).toBe(false);
  await page.getByRole("button", { name: "返回播放页", exact: true }).click();
  expect((await media(page)).paused).toBe(true);
});

test("灯光编排升级重建旧缓存并保留已准备音频", async ({}, info) => {
  test.setTimeout(120_000);
  const directory = path.join(privateRoot, "program-upgrade-cache");
  const first = createMusicLibrary(root!, directory);
  const prepared = await first.prepare(representative[0].id);
  const files = await fsp.readdir(directory);
  const metadata = path.join(directory, files.find((file) => /^[a-f0-9]{64}\.json$/.test(file))!);
  const audioFile = path.join(directory, files.find((file) => /^[a-f0-9]{64}\.m4a$/.test(file))!);
  const audioBefore = { hash: await fileHash(audioFile), mtime: (await fsp.stat(audioFile)).mtimeMs };
  const stale = { ...prepared, program: { ...prepared.program!, version: 3, cues: [] } };
  await fsp.writeFile(metadata, JSON.stringify(stale));
  const restarted = createMusicLibrary(root!, directory);
  const fresh = await restarted.prepare(representative[0].id);
  expect(fresh.program!.version).toBe(4);
  expect(fresh.program!.cues.length).toBeGreaterThan(2);
  expect(fresh.program!.cues.some((cue) => addedLooks.includes(cue.look))).toBe(true);
  expect({ hash: await fileHash(audioFile), mtime: (await fsp.stat(audioFile)).mtimeMs }).toEqual(audioBefore);
  expect(JSON.parse(await fsp.readFile(metadata, "utf8")).program.version).toBe(4);
  fs.writeFileSync(info.outputPath("program-upgrade.json"), JSON.stringify({ oldVersion: 3, newVersion: fresh.program!.version, audioUnchanged: true, cues: fresh.program!.cues }, null, 2));
});

test("真实切歌晚到与准备故障可恢复，手机选曲和灯光面板可操作", async ({ page, request }, info) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 393, height: 852 });
  for (const track of representative) expect((await request.get(`/__prototype/music/prepare/${track.id}`, { timeout: 120_000 })).ok()).toBe(true);
  await enter(page);
  // 网络边界延迟旧曲返回，不修改播放器的内部数据。
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/prepare/${representative[1].id}`, async (route) => { const response = await route.fetch(); await gate; await route.fulfill({ response }).catch(() => {}); });
  await choose(page, representative[1].title);
  await choose(page, representative[2].title);
  await expect.poll(async () => (await media(page)).src).toContain(`/audio/${representative[2].id}`);
  release(); await page.unroute(`**/prepare/${representative[1].id}`);
  await expect.poll(async () => (await media(page)).paused).toBe(false);
  expect((await media(page)).src).toContain(`/audio/${representative[2].id}`);
  await page.route(`**/prepare/${representative[1].id}`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "音源准备暂时失败，请重试。" }) }));
  await choose(page, representative[1].title);
  await expect(page.getByRole("alert")).toContainText("音源准备暂时失败");
  expect((await media(page)).paused).toBe(true);
  await page.screenshot({ path: info.outputPath("real-source-failure-mobile.png") });
  await page.unroute(`**/prepare/${representative[1].id}`);
  await page.getByRole("button", { name: "重试音频", exact: true }).click();
  await expect.poll(async () => (await media(page)).src).toContain(`/audio/${representative[1].id}`);
  await expect.poll(async () => (await media(page)).paused).toBe(false);
  const before = await sound(page); await expect.poll(() => sound(page)).toBeGreaterThan(before + 4);
  await page.getByRole("button", { name: "灯光编排", exact: true }).click();
  await expect(page.locator(".av-look-grid > button")).toHaveCount(12);
  await page.screenshot({ path: info.outputPath("twelve-looks-mobile.png") });
  await page.getByRole("button", { name: "全场齐射", exact: true }).click();
  await page.screenshot({ path: info.outputPath("real-stage-mobile.png") });
  await page.getByRole("button", { name: "选择真实曲目", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索真实曲目" }).fill("no such track xyz");
  await expect(page.getByText("没有找到匹配的曲目")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.getByRole("button", { name: "灯光编排", exact: true }).click();
  await page.getByRole("button", { name: "纵深光廊", exact: true }).click();
  await page.screenshot({ path: info.outputPath("real-stage-compact.png") });
});

test("真实音源只读接口拒绝越界与非法范围，临时曲库验证匹配和符号链接边界", async ({ request }, info) => {
  test.setTimeout(90_000);
  const catalog = await (await request.get("/__prototype/music/catalog")).json() as MusicCatalog;
  expect(catalog.enabled).toBe(true); expect(catalog.tracks.length).toBe(1054); expect(catalog.unmatched).toBe(0);
  const id = representative[0].id;
  expect((await request.get(`/__prototype/music/prepare/${id}`, { timeout: 120_000 })).ok()).toBe(true);
  const audioUrl = `/__prototype/music/audio/${id}`;
  const range = await request.get(audioUrl, { headers: { Range: "bytes=0-63" } });
  expect(range.status()).toBe(206); expect((await range.body()).length).toBe(64);
  expect(range.headers()["content-range"]).toMatch(/^bytes 0-63\/\d+$/);
  expect((await request.get(audioUrl, { headers: { Range: "bytes=-64" } })).status()).toBe(206);
  for (const value of ["bytes=-0", "bytes=9-2", "bytes=999999999999999999999-", "bytes=0-1,3-4", "bytes=x-y"]) {
    const invalid = await request.get(audioUrl, { headers: { Range: value } });
    expect(invalid.status()).toBe(416); expect(invalid.headers()["content-range"]).toMatch(/^bytes \*\//);
  }
  expect((await request.post(audioUrl)).status()).toBe(405);
  expect((await request.get(audioUrl, { headers: { Origin: "https://unrelated.invalid" } })).status()).toBe(403);
  expect((await request.get("/__prototype/music/audio/%2e%2e%2fprivate")).status()).toBe(404);
  expect((await request.get("/__prototype/music/audio/000000000000000000000000")).status()).toBe(404);
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "prototype-music-boundary-"));
  const music = path.join(temporary, "music"), cache = path.join(temporary, "cache"), outside = path.join(temporary, "outside.m4a");
  await fsp.mkdir(music);
  const track = snapshot.tracks.find((item) => item.id === id)!;
  const album = snapshot.albums.find((item) => item.id === track.albumId)!;
  const fixture = path.join(music, "fixture.m4a");
  const generated = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=12000", "-t", String(track.duration), "-c:a", "alac", "-metadata", `title=${track.title}`, "-metadata", `album=${album.title}`, "-metadata", `track=${track.number}`, "-metadata", `disc=${track.disc}`, fixture]);
  expect(generated.status).toBe(0);
  await fsp.copyFile(fixture, outside);
  await fsp.symlink(outside, path.join(music, "outside-link.m4a"));
  const local = createMusicLibrary(music, cache);
  expect(() => createMusicLibrary(music, path.join(music, "cache"))).toThrow("音乐目录之外");
  expect((await local.catalog()).tracks.map((item) => item.id)).toEqual([id]);
  const before = await fileHash(fixture);
  const cacheAlias = path.join(temporary, "cache-alias");
  await fsp.symlink(music, cacheAlias);
  await expect(createMusicLibrary(music, path.join(cacheAlias, "nested-cache")).prepare(id)).rejects.toThrow("音乐目录之外");
  expect(fs.existsSync(path.join(music, "nested-cache"))).toBe(false);
  const limited = createMusicLibrary(music, cache);
  const admitted = [limited.prepare(id), limited.prepare("000000000000000000000000")];
  await expect(limited.prepare("111111111111111111111111")).rejects.toMatchObject({ status: 503 });
  const admission = await Promise.allSettled(admitted);
  expect(admission[0].status).toBe("fulfilled"); expect(admission[1].status).toBe("rejected");
  const [one, two] = await Promise.all([local.prepare(id), local.prepare(id)]);
  expect(one.sourceHash).toBe(before); expect(two).toEqual(one);
  expect(await fileHash(fixture)).toBe(before);
  await fsp.copyFile(fixture, path.join(music, "duplicate.m4a"));
  expect((await createMusicLibrary(music, cache).catalog()).tracks).toEqual([]);
  await fsp.unlink(fixture); await fsp.symlink(outside, fixture);
  await expect(local.audio(id)).rejects.toThrow("文件暂时不可用");
  const server = await createServer({ configFile: false, root: temporary, plugins: [musicPlugin(music, cache)], server: { host: "127.0.0.1", port: 0 } });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("临时服务没有监听端口");
    const noMatch = await fetch(`http://127.0.0.1:${address.port}/__prototype/music/prepare/${id}`);
    // 唯一留下的普通副本仍是有效匹配；源文件替换不能绕过原实例的路径验证。
    expect(noMatch.status).toBe(200);
    await fsp.writeFile(path.join(music, "duplicate.m4a"), "corrupted temporary audio");
    const corrupt = await fetch(`http://127.0.0.1:${address.port}/__prototype/music/prepare/${id}`);
    expect(corrupt.status).toBe(422);
    expect(await corrupt.text()).not.toContain(temporary);
  } finally { await server.close(); }
  fs.writeFileSync(info.outputPath("read-only-boundaries.json"), JSON.stringify({ catalogCount: catalog.tracks.length, sourceHashBefore: before, sourceHashAfter: one.sourceHash, symlinkRejected: true, ambiguousRejected: true, rangeValidated: true, temporary }, null, 2));
});
