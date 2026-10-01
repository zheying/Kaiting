import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import { analyzeMusic, createLightingStore } from "../src/server/lighting.js";

// 边界先于实现确定：只读真实解码、缓存重用/失效/损坏、路径与符号链接、
// 同源合并与并发限制、关闭取消、处理中替换源文件必须丢弃结果。
let root: string, config: AppConfig, file: string;
const stores: ReturnType<typeof createLightingStore>[] = [];
function store(...args: Parameters<typeof createLightingStore>) { const value = createLightingStore(...args); stores.push(value); return value; }
function generate(frequency = 440) {
  const result = spawnSync("ffmpeg", ["-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=2`, file]);
  expect(result.status).toBe(0);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lighting-test-"));
  const dataDir = path.join(root, "data"), musicLibraryPath = path.join(root, "music");
  fs.mkdirSync(dataDir); fs.mkdirSync(musicLibraryPath);
  config = { dataDir, musicLibraryPath } as AppConfig;
  file = path.join(musicLibraryPath, "test.wav"); generate();
});
afterEach(() => { for (const value of stores.splice(0)) value.close(); fs.rmSync(root, { recursive: true, force: true }); });

it("真实解码只写数据缓存，重启重用并在源文件变化或缓存损坏后重建", async () => {
  const before = fs.readFileSync(file); let calls = 0;
  const decode: typeof analyzeMusic = async (...args) => { calls++; return analyzeMusic(...args); };
  const one = store(config, decode);
  const first = await one.read({ path: file, duration: 2 });
  expect(first.duration).toBeCloseTo(2, 1); expect(first.cues.length).toBeGreaterThan(0);
  expect(fs.readFileSync(file)).toEqual(before);
  expect(await store(config, decode).read({ path: file, duration: 2 })).toEqual(first);
  expect(calls).toBe(1);
  const directory = path.join(config.dataDir, "lighting");
  const cached = path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith(".json"))!);
  fs.writeFileSync(cached, "{broken");
  await store(config, decode).read({ path: file, duration: 2 }); expect(calls).toBe(2);
  generate(1200);
  await one.read({ path: file, duration: 2 }); expect(calls).toBe(3);
  expect(fs.readdirSync(config.musicLibraryPath)).toEqual(["test.wav"]);
});

it("拒绝越界源文件、源符号链接和指向曲库的缓存目录", async () => {
  const outside = path.join(root, "outside.wav"); fs.copyFileSync(file, outside);
  const value = store(config);
  await expect(value.read({ path: outside, duration: 2 })).rejects.toThrow();
  fs.unlinkSync(file); fs.symlinkSync(outside, file);
  await expect(value.read({ path: file, duration: 2 })).rejects.toThrow();
  fs.unlinkSync(file); generate();
  fs.symlinkSync(config.musicLibraryPath, path.join(config.dataDir, "lighting"));
  await expect(value.read({ path: file, duration: 2 })).rejects.toThrow();
  expect(fs.readdirSync(config.musicLibraryPath)).toEqual(["test.wav"]);
});

it("同源并发只解码一次，超出并发立即拒绝且关闭会取消解码", async () => {
  let calls = 0, cancelled = 0;
  const decode: typeof analyzeMusic = (_file, signal) => new Promise((_resolve, reject) => {
    calls++; signal.addEventListener("abort", () => { cancelled++; reject(new Error("cancelled")); }, { once: true });
  });
  const value = store(config, decode);
  const first = value.read({ path: file, duration: 2 });
  const duplicate = value.read({ path: file, duration: 2 });
  const two = path.join(config.musicLibraryPath, "two.wav"); fs.copyFileSync(file, two);
  const second = value.read({ path: two, duration: 2 });
  const pending = Promise.allSettled([first, duplicate, second]);
  await expect.poll(() => calls).toBe(2);
  const three = path.join(config.musicLibraryPath, "three.wav"); fs.copyFileSync(file, three);
  await expect(value.read({ path: three, duration: 2 })).rejects.toMatchObject({ statusCode: 503 });
  value.close(); await pending; expect(cancelled).toBe(2);
  await expect(value.read({ path: file, duration: 2 })).rejects.toThrow();
});

it("解码期间源文件变化不保存旧结果，超长与无效录音有界失败", async () => {
  const value = store(config, async (...args) => { const result = await analyzeMusic(...args); generate(1500); return result; });
  await expect(value.read({ path: file, duration: 2 })).rejects.toThrow();
  expect(fs.readdirSync(path.join(config.dataDir, "lighting")).filter((name) => name.endsWith(".json"))).toEqual([]);
  await expect(value.read({ path: file, duration: 3000 })).rejects.toMatchObject({ statusCode: 422 });
  fs.writeFileSync(file, "invalid audio");
  await expect(store(config).read({ path: file, duration: 2 })).rejects.toThrow();
});
