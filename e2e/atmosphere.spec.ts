import { test, expect, titles } from "./helpers/room.js";
import { observeAtmosphere, soundSnapshot } from "./helpers/atmosphere-observation.js";
import fs from "node:fs";
import path from "node:path";
import { observeBeats, beatObservation, resetBeatObservation, brightest } from "./helpers/lighting-observation.js";

test.use({ reducedMotion: "no-preference", roomOptions: { audioDuration: 45, rhythmic: true } });

for (const [format, width, height] of [["aac", 1280, 900], ["alac", 393, 852]] as const) {
  test(`氛围 ${format.toUpperCase()} ${width} 普通页往返连续播放，共用队列与歌词时钟`, async ({ page, room }, info) => {
    await page.setViewportSize({ width, height });
    await observeAtmosphere(page);
    await room.ready(page);
    await page.locator(".main-content .track-identity").filter({ hasText: titles[format] }).click();
    const capsule = page.getByRole("contentinfo", { name: "底部播放器" });
    await expect(capsule.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
    await capsule.getByRole("button", { name: /^打开沉浸播放器/ }).click();
    const full = page.getByRole("dialog", { name: "沉浸播放器" });
    await expect.poll(async () => (await soundSnapshot(page)).rms).toBeGreaterThan(.002);
    const before = await soundSnapshot(page);
    await full.getByRole("button", { name: "进入氛围模式", exact: true }).click();
    const atmosphere = full.getByRole("region", { name: "氛围模式", exact: true });
    await expect(atmosphere).toBeVisible();
    await atmosphere.getByRole("button", { name: "返回播放页", exact: true }).click();
    await full.getByRole("button", { name: "进入氛围模式", exact: true }).click();
    const after = await soundSnapshot(page);
    expect(after.index).toBe(before.index); expect(after.src).toBe(before.src);
    expect(after.connections).toBe(before.connections); expect(after.paused).toBe(false);
    expect(after.time!).toBeGreaterThan(before.time!);
    expect(after.events.filter((event) => event.at > before.at)).toEqual([]);
    const samples = after.samples.filter((sample) => sample.at > before.at);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((sample) => sample.index === before.index && sample.rms > .0001)).toBe(true);
    await atmosphere.getByRole("button", { name: "氛围暂停", exact: true }).click();
    const lyricsToggle = atmosphere.getByRole("button", { name: "氛围歌词", exact: true });
    await lyricsToggle.click();
    await expect(lyricsToggle).toHaveAttribute("aria-pressed", "true");
    await expect(atmosphere.getByRole("button", { name: "收起歌词", exact: true })).toHaveCount(0);
    const lyricHint = atmosphere.locator(".np-lyrics-toolbar");
    await expect(lyricHint).toHaveText("");
    await expect(atmosphere.getByText("点击播放，查看歌词动效", { exact: true })).toHaveCount(0);
    await atmosphere.getByRole("button", { name: "跳转到 0:01，第一句测试歌词" }).click();
    await expect(atmosphere.locator(".np-lyric-line.is-current")).toContainText("第一句测试歌词");
    await expect(atmosphere.getByRole("slider", { name: "氛围播放进度" })).toHaveValue("1");
    await lyricsToggle.click();
    await expect(lyricsToggle).toHaveAttribute("aria-pressed", "false");
    await expect(atmosphere.locator(".av-companion-lyrics")).toHaveCount(0);
    await expect(atmosphere.getByRole("slider", { name: "氛围播放进度" })).toHaveValue("1");
    await lyricsToggle.click();
    await expect(lyricsToggle).toHaveAttribute("aria-pressed", "true");
    await expect(atmosphere.locator(".np-lyric-line.is-current")).toContainText("第一句测试歌词");
    await info.attach(`lyrics-paused-${width}.png`, { body: await atmosphere.screenshot(), contentType: "image/png" });
    await atmosphere.getByLabel("可滚动歌词，点击任一句跳转播放进度", { exact: true }).press("PageDown");
    const returnToLyrics = atmosphere.getByRole("button", { name: "回到当前歌词", exact: true });
    await expect(returnToLyrics).toBeVisible();
    await info.attach(`lyrics-browsing-${width}.png`, { body: await atmosphere.screenshot(), contentType: "image/png" });
    await returnToLyrics.click();
    await expect(lyricHint).toHaveText("");
    await expect(atmosphere.getByRole("slider", { name: "氛围播放进度" })).toHaveValue("1");
    await expect.poll(async () => {
      const line = await atmosphere.locator(".np-lyric-line.is-current").boundingBox();
      const viewport = await atmosphere.locator(".np-lyrics-scroll").boundingBox();
      return !!line && !!viewport && line.y >= viewport.y && line.y + line.height <= viewport.y + viewport.height;
    }).toBe(true);
    if (width === 393) {
      await page.setViewportSize({ width, height: 667 });
      await atmosphere.getByLabel("可滚动歌词，点击任一句跳转播放进度", { exact: true }).press("PageDown");
      await expect(returnToLyrics).toBeVisible();
      const hint = await returnToLyrics.boundingBox();
      expect(hint!.height).toBeGreaterThanOrEqual(44);
      await info.attach("lyrics-short-screen.png", { body: await atmosphere.screenshot(), contentType: "image/png" });
      await returnToLyrics.click();
      await expect(lyricHint).toHaveText("");
      await page.setViewportSize({ width, height });
    }
    await atmosphere.getByRole("button", { name: "氛围播放", exact: true }).click();
    await expect(lyricHint).toHaveText("");
    await expect.poll(async () => (await soundSnapshot(page)).time).toBeGreaterThan(1.2);
    await info.attach(`lyrics-playing-${width}.png`, { body: await atmosphere.screenshot(), contentType: "image/png" });
    await atmosphere.getByRole("button", { name: "氛围暂停", exact: true }).click();
    await expect(lyricHint).toHaveText("");
    await atmosphere.getByRole("button", { name: "跳转到 0:01，第一句测试歌词" }).click();
    await atmosphere.getByRole("button", { name: "返回播放页" }).click();
    await expect(full.locator(".np-lyric-line.is-current")).toContainText("第一句测试歌词");
    await expect(full.locator(".np-lyrics-toolbar")).toHaveText("逐行歌词");
    await expect(full.getByText("点击播放，查看歌词动效", { exact: true })).toBeVisible();
    await expect(full.getByRole("button", { name: "播放", exact: true })).toBeVisible();
    await full.getByRole("button", { name: "待播清单", exact: true }).click();
    const queue = await full.locator(".np-queue-select strong").allTextContents();
    await full.getByRole("button", { name: "进入氛围模式" }).click();
    expect(await atmosphere.locator(".np-queue-select strong").allTextContents()).toEqual(queue);
    await expect(atmosphere.getByRole("button", { name: "收起待播清单", exact: true })).toBeVisible();
    await atmosphere.getByRole("button", { name: `播放 ${titles.mp3}`, exact: true }).click();
    await expect(atmosphere.getByRole("heading", { name: titles.mp3, exact: true })).toBeVisible();
    await expect(atmosphere.getByRole("button", { name: "氛围暂停" })).toBeVisible();
    await atmosphere.getByRole("button", { name: "氛围暂停" }).click();
    await info.attach("continuity.json", { body: JSON.stringify({ before, after, final: await soundSnapshot(page) }), contentType: "application/json" });
    await info.attach(`atmosphere-${width}.png`, { body: await atmosphere.screenshot(), contentType: "image/png" });
  });
}

test("氛围 22 种灯光、面板和外侧关闭保持舞台布局", async ({ page, room }, info) => {
  await observeAtmosphere(page); await observeBeats(page);
  await room.ready(page);
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  const capsule = page.getByRole("contentinfo", { name: "底部播放器" });
  await capsule.getByRole("button", { name: "暂停", exact: true }).click();
  await capsule.getByRole("button", { name: /^打开沉浸播放器/ }).click();
  await page.getByRole("button", { name: "进入氛围模式" }).click();
  const stage = page.getByRole("region", { name: "氛围模式", exact: true });
  // 完整播放器的入场动画结束后，才比较面板开关造成的几何变化。
  await expect.poll(async () => (await stage.locator(".av-visual").boundingBox())?.y).toBe(0);
  const before = await stage.locator(".av-visual").boundingBox();
  await stage.getByRole("button", { name: "灯光编排", exact: true }).click();
  const choices = stage.locator(".av-look-grid > button");
  await expect(choices).toHaveCount(22);
  const labels = await choices.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")!));
  for (const label of labels) {
    await stage.getByRole("button", { name: label, exact: true }).click();
    await expect(stage.locator(".av-picker")).toHaveCount(0);
    await stage.getByRole("button", { name: "灯光编排", exact: true }).click();
    await expect(stage.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await stage.click({ position: { x: 20, y: 300 } });
  await expect(stage.locator(".av-picker")).toHaveCount(0);
  await stage.getByRole("button", { name: "氛围歌词" }).click();
  await expect(stage.locator(".np-lyric-line")).toHaveCount(3);
  expect(await stage.locator(".av-visual").boundingBox()).toEqual(before);
  await stage.getByRole("button", { name: "氛围待播清单" }).click();
  await expect(stage.getByRole("heading", { name: /接下来播放/ })).toBeVisible();
  expect(await stage.locator(".av-visual").boundingBox()).toEqual(before);
  await stage.getByRole("button", { name: "画面设置", exact: true }).click();
  await stage.getByRole("button", { name: "轻柔", exact: true }).click();
  await stage.press("Escape"); await expect(stage.locator(".av-settings")).toHaveCount(0);
  await stage.press("Escape"); await expect(stage.locator(".av-companion")).toHaveCount(0);
  const rig = await beatObservation(page);
  expect(rig.fixedOrigins).toHaveLength(72); expect(rig.maxDisplacement).toBe(0);
  await info.attach("fixed-rig.json", { body: JSON.stringify({ origins: rig.fixedOrigins, maxDisplacement: rig.maxDisplacement }), contentType: "application/json" });
  await info.attach("lighting-picker-and-panels.png", { body: await stage.screenshot(), contentType: "image/png" });
});

test("氛围分析失败与 WebGL 降级不阻塞真实播放", async ({ page, room }, info) => {
  await observeAtmosphere(page);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
      if (kind.startsWith("webgl")) return null;
      return Reflect.apply(original, this, [kind, ...args]);
    } as typeof original;
  });
  await page.route("**/api/tracks/*/lighting", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "分析暂时不可用" }) }));
  await room.ready(page);
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  await page.getByRole("button", { name: /^打开沉浸播放器/ }).click();
  await page.getByRole("button", { name: "进入氛围模式" }).click();
  const stage = page.getByRole("region", { name: "氛围模式", exact: true });
  await expect(stage).toContainText("此设备使用简化画面");
  await expect(stage).toContainText("实时跟随声音");
  await expect.poll(async () => (await soundSnapshot(page)).rms).toBeGreaterThan(.002);
  await stage.getByRole("button", { name: "氛围静音" }).click();
  await expect.poll(async () => (await soundSnapshot(page)).gains[0]).toBeLessThan(.001);
  await expect.poll(async () => (await soundSnapshot(page)).rms).toBeGreaterThan(.002);
  await stage.getByRole("button", { name: "氛围恢复音量" }).click();
  await expect.poll(async () => (await soundSnapshot(page)).gains[0]).toBeGreaterThan(.01);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stage.getByRole("button", { name: "氛围暂停" }).click();
  await info.attach("fallback.png", { body: await stage.screenshot(), contentType: "image/png" });
});

test("氛围编排接口鉴权、实际缓存与源文件只读边界", async ({ page, room, playwright }, info) => {
  await room.ready(page);
  const track = await room.track(page.request, titles.aac);
  const endpoint = `${room.url}/api/tracks/${track.id}/lighting`;
  const anonymous = await playwright.request.newContext();
  try { expect((await anonymous.get(endpoint)).status()).toBe(401); } finally { await anonymous.dispose(); }
  const response = await page.request.get(endpoint);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("private");
  const { program } = await response.json();
  expect(program.version).toBe(5); expect(program.duration).toBeCloseTo(45, 0);
  expect(program.cues.length).toBeGreaterThan(0);
  const directory = path.join(room.data, "lighting");
  const cached = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  expect(cached).toHaveLength(1);
  const before = fs.statSync(path.join(directory, cached[0])).mtimeMs;
  expect(await (await page.request.get(endpoint)).json()).toEqual({ program });
  expect(fs.statSync(path.join(directory, cached[0])).mtimeMs).toBe(before);
  expect((await page.request.get(endpoint + "?path=outside")).status()).toBe(400);
  const held = `${track.path}.held`, outside = path.join(room.directory, "outside.m4a");
  fs.copyFileSync(track.path, outside); fs.renameSync(track.path, held); fs.symlinkSync(outside, track.path);
  try { expect((await page.request.get(endpoint)).status()).toBe(404); }
  finally { fs.unlinkSync(track.path); fs.renameSync(held, track.path); }
  await info.attach("program.json", { body: JSON.stringify(program), contentType: "application/json" });
});

test("氛围切歌丢弃晚到编排，选曲沿用当前队列", async ({ page, room }, info) => {
  await room.ready(page);
  const first = await room.track(page.request, titles.aac);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let received = false;
  await page.route(`**/api/tracks/${first.id}/lighting`, async (route) => {
    const response = await route.fetch(); const result = await response.json();
    // 在 HTTP 边界标记旧请求；不修改音频或播放器状态。
    result.program.cues.forEach((cue: { look: string }) => { cue.look = "burst"; });
    received = true; await gate;
    await route.fulfill({ response, json: result }).catch(() => {});
  });
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  await page.getByRole("button", { name: /^打开沉浸播放器/ }).click();
  await page.getByRole("button", { name: "进入氛围模式" }).click();
  const stage = page.getByRole("region", { name: "氛围模式", exact: true });
  await expect.poll(() => received).toBe(true);
  await stage.getByRole("button", { name: "选择曲目" }).click();
  await stage.getByRole("textbox", { name: "搜索曲目" }).fill(titles.alac);
  await stage.getByRole("button", { name: `播放曲目 ${titles.alac}` }).click();
  await expect(stage.getByRole("heading", { name: titles.alac, exact: true })).toBeVisible();
  await expect(stage.locator(".av-sound-label")).toContainText("本曲灯光编排");
  const look = await stage.getAttribute("data-lighting-look"); expect(look).not.toBe("burst");
  release(); await page.unroute(`**/api/tracks/${first.id}/lighting`);
  await expect(stage).toHaveAttribute("data-lighting-look", look!);
  await stage.getByRole("button", { name: "氛围暂停" }).click();
  await info.attach("late-program.png", { body: await stage.screenshot(), contentType: "image/png" });
});

test("声音分析不受支持时保留原生播放，授权恢复失败可重试", async ({ page, room }, info) => {
  await observeAtmosphere(page);
  await room.ready(page);
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  await expect.poll(async () => (await soundSnapshot(page)).rms).toBeGreaterThan(.002);
  await player.getByRole("button", { name: "暂停", exact: true }).click();
  await page.evaluate(() => {
    const original = AudioContext.prototype.resume;
    (window as unknown as { restoreAudioResume: () => void }).restoreAudioResume = () => { AudioContext.prototype.resume = original; };
    AudioContext.prototype.resume = () => Promise.reject(new DOMException("permission denied", "NotAllowedError"));
  });
  await player.getByRole("button", { name: "播放", exact: true }).click();
  await expect(page.getByRole("button", { name: "点击播放", exact: true })).toBeVisible();
  expect((await soundSnapshot(page)).paused).toBe(true);
  await page.evaluate(() => (window as unknown as { restoreAudioResume: () => void }).restoreAudioResume());
  await page.getByRole("button", { name: "点击播放", exact: true }).click();
  await expect.poll(async () => (await soundSnapshot(page)).rms).toBeGreaterThan(.002);
  await player.getByRole("button", { name: /^打开沉浸播放器/ }).click();
  await page.getByRole("button", { name: "进入氛围模式" }).click();
  await expect(page.getByRole("region", { name: "氛围模式", exact: true })).not.toContainText("声音分析暂不可用");
  await page.getByRole("button", { name: "返回播放页" }).click();
  await page.getByRole("button", { name: "收起播放器", exact: true }).click();
  await player.getByRole("button", { name: "暂停", exact: true }).click();
  // 外部浏览器 API 不存在时，播放器应继续走原生媒体路径。
  const track = await room.track(page.request, titles.aac);
  await expect.poll(async () => (await room.api(page.request, "/api/me")).preferences.currentId).toBe(track.id);
  await page.addInitScript(() => { Object.defineProperty(window, "AudioContext", { value: undefined }); });
  await page.reload();
  await expect(player).toBeVisible();
  await player.getByRole("button", { name: "播放", exact: true }).click();
  await expect.poll(async () => (await soundSnapshot(page)).time ?? 0).toBeGreaterThan(1);
  await player.getByRole("button", { name: /^打开沉浸播放器/ }).click();
  await page.getByRole("button", { name: "进入氛围模式" }).click();
  await expect(page.getByRole("region", { name: "氛围模式", exact: true })).toContainText("不支持声音分析");
  await page.getByRole("button", { name: "氛围暂停" }).click();
  await info.attach("native-audio-fallback.png", { body: await page.screenshot(), contentType: "image/png" });
});

test("正式音源重拍迅速提亮并回落，暂停后停止运动", async ({ page, room }, info) => {
  await observeAtmosphere(page); await observeBeats(page);
  await room.ready(page);
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  const capsule = page.getByRole("contentinfo", { name: "底部播放器" });
  await capsule.getByRole("button", { name: "暂停", exact: true }).click();
  await capsule.getByRole("button", { name: /^打开沉浸播放器/ }).click();
  await page.getByRole("button", { name: "进入氛围模式" }).click();
  const stage = page.getByRole("region", { name: "氛围模式", exact: true });
  await stage.getByRole("button", { name: "灯光编排", exact: true }).click();
  await stage.getByRole("button", { name: "交错织光", exact: true }).click();
  await stage.getByRole("slider", { name: "氛围播放进度" }).press("Home");
  await resetBeatObservation(page, true);
  await stage.getByRole("button", { name: "氛围播放" }).click();
  await expect.poll(async () => (await soundSnapshot(page)).time ?? 0).toBeGreaterThan(5.8);
  await page.mouse.move(25, 25);
  await stage.getByRole("button", { name: "氛围暂停" }).click();
  const data = await beatObservation(page);
  const hits = Array.from({ length: 9 }, (_, index) => 1 + index * .5).map((hit) => {
    const before = data.samples.filter((sample) => sample.time >= hit - .18 && sample.time < hit - .03);
    const attack = data.samples.filter((sample) => sample.time >= hit && sample.time <= hit + .15);
    const after = data.samples.filter((sample) => sample.time >= hit + .25 && sample.time <= hit + .38);
    const base = Math.max(...before.map(brightest)), peak = Math.max(...attack.map(brightest));
    return { hit, contrast: peak / base, recovery: Math.min(...after.map(brightest)) / peak };
  });
  await info.attach("beats.json", { body: JSON.stringify({ hits, samples: data.samples }), contentType: "application/json" });
  for (const hit of hits) { expect(hit.contrast).toBeGreaterThan(1.65); expect(hit.recovery).toBeLessThan(.72); }
  expect(data.maxDisplacement).toBe(0);
  await page.waitForTimeout(850);
  const visual = () => stage.locator(".av-visual").screenshot({ mask: [stage.locator(".av-hud"), stage.locator(".av-wake-hint")] });
  const stopped = await visual();
  await page.waitForTimeout(250);
  expect((await visual()).equals(stopped)).toBe(true);
  await info.attach("beat-peak.png", { body: Buffer.from(data.peak.split(",")[1], "base64"), contentType: "image/png" });
});
