import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { observePanels, finishPanelObservation } from "./panel-observation.js";
import { observeBeats, beatObservation, resetBeatObservation, brightest, percussionReference, referenceHits, type LightSample } from "./beat-observation.js";

type Probe = { reads: number; nonzero: number; maximum: number; gain: GainNode | null };
type ObservedWindow = Window & { soundProbe: Probe; graphicsBoundary?: WEBGL_lose_context | null };
const evidence = new WeakMap<Page, { requests: string[]; errors: string[]; exceptions: string[] }>();

test.beforeEach(async ({ page }) => {
  const log = { requests: [] as string[], errors: [] as string[], exceptions: [] as string[] };
  evidence.set(page, log);
  page.on("request", (request) => log.requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  page.on("console", (message) => { if (message.type() === "error") log.errors.push(message.text()); });
  page.on("pageerror", (error) => log.exceptions.push(error.message));
  // 只观察真实音频图的输出，不改变播放器状态或伪造媒体事件。
  await page.addInitScript(() => {
    const probe: Probe = { reads: 0, nonzero: 0, maximum: 0, gain: null };
    (window as unknown as ObservedWindow).soundProbe = probe;
    const read = AnalyserNode.prototype.getByteFrequencyData;
    AnalyserNode.prototype.getByteFrequencyData = function (values) {
      read.call(this, values);
      const maximum = Math.max(...values);
      probe.reads++; if (maximum > 0) probe.nonzero++;
      probe.maximum = Math.max(probe.maximum, maximum);
    };
    const create = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function () { const gain = create.call(this); probe.gain = gain; return gain; };
  });
});

test.afterEach(async ({ page }, info) => {
  const log = evidence.get(page);
  const observations = await page.locator("audio").evaluateAll((items) => items.map((item) => {
    const audio = item as HTMLAudioElement;
    return { paused: audio.paused, currentTime: audio.currentTime, duration: audio.duration, error: audio.error?.code ?? null };
  })).catch(() => []);
  fs.writeFileSync(info.outputPath("media-observation.json"), JSON.stringify({ status: info.status, observations }, null, 2));
  await info.attach("media-observation", { path: info.outputPath("media-observation.json"), contentType: "application/json" });
  fs.writeFileSync(info.outputPath("requests-and-console.json"), JSON.stringify(log, null, 2));
  expect(log?.exceptions).toEqual([]);
  if (!info.title.startsWith("音源请求失败")) expect(log?.errors).toEqual([]);
});

async function enter(page: Page) {
  await page.goto("/#/playing");
  await page.getByRole("button", { name: "进入氛围模式", exact: true }).click();
  await expect(page.getByRole("region", { name: "氛围模式", exact: true })).toBeVisible();
}
const playing = (page: Page) => page.locator("audio").evaluate((element) => !(element as HTMLAudioElement).paused);
// 只比较舞台，遮住叠在画布上的播放时间与控制，避免把进度更新当作灯光变化。
const visualFrame = (page: Page) => page.locator(".av-visual").screenshot({ mask: [page.locator(".av-hud"), page.locator(".av-wake-hint")] });

test("重拍迅速响应并回落，持续低音不连闪，轻柔与静音保留正确力度", async ({ page }, info) => {
  test.setTimeout(100_000);
  const reference = percussionReference();
  await page.route("**/audio/atmosphere-demo.wav", (route) => route.fulfill({ contentType: "audio/wav", body: reference }));
  await observeBeats(page);
  await enter(page);
  await expect(page.getByRole("button", { name: "氛围播放", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "灯光编排", exact: true }).click();
  await page.getByRole("button", { name: "交错织光", exact: true }).click();
  const seek = async (seconds: number) => {
    const slider = page.getByRole("slider", { name: "氛围播放进度", exact: true });
    await slider.focus(); await slider.fill(String(seconds)); await slider.press("Tab");
  };
  const playThrough = async (start: number, end: number) => {
    await seek(start);
    await resetBeatObservation(page, true);
    await page.getByRole("button", { name: "氛围播放", exact: true }).click();
    await expect.poll(() => page.locator("audio").evaluate((a) => (a as HTMLAudioElement).currentTime), { timeout: 20_000 }).toBeGreaterThan(end);
    await page.mouse.move(30, 30);
    await page.getByRole("button", { name: "氛围暂停", exact: true }).click();
    return beatObservation(page);
  };
  const vivid = await playThrough(0, 11.5);
  const report = (samples: LightSample[], hits: number[]) => hits.map((hit) => {
    const before = samples.filter((f) => f.time >= hit - .18 && f.time < hit - .03);
    const attack = samples.filter((f) => f.time >= hit && f.time <= hit + .15);
    const after = samples.filter((f) => f.time >= hit + .25 && f.time <= hit + .38);
    const base = Math.max(...before.map(brightest));
    const peak = Math.max(...attack.map(brightest));
    const first = attack.find((f) => brightest(f) >= base * 1.65);
    return { hit, contrast: peak / base, latency: first ? first.time - hit : null, recovery: Math.min(...after.map(brightest)) / peak };
  });
  const vividHits = report(vivid.samples, referenceHits);
  fs.writeFileSync(info.outputPath("beat-reference-observation.json"), JSON.stringify({ expectedHits: referenceHits, vividHits, samples: vivid.samples }, null, 2));
  fs.writeFileSync(info.outputPath("beat-reference.wav"), reference);
  for (const [name, data] of [["peak", vivid.peak], ["rest", vivid.rest]]) fs.writeFileSync(info.outputPath(`reference-${name}.png`), Buffer.from(data.split(",")[1], "base64"));
  // 每个参考敲击须在 150 ms 内形成明显反差，随后回落；不接受持续亮着冒充重拍。
  for (const hit of vividHits) {
    expect(hit.latency, `起音 ${hit.hit}s 的灯光响应`).not.toBeNull();
    expect(hit.contrast).toBeGreaterThan(1.65);
    expect(hit.recovery).toBeLessThan(.72);
  }
  const sustained = vivid.samples.filter((f) => f.time >= 9 && f.time < 10.8).map(brightest);
  expect(Math.max(...sustained) / Math.min(...sustained)).toBeLessThan(1.18);
  await page.waitForTimeout(850);
  const paused = await visualFrame(page);
  await page.waitForTimeout(300);
  expect((await visualFrame(page)).equals(paused)).toBe(true);

  await page.getByRole("button", { name: "画面设置", exact: true }).click();
  await page.getByRole("button", { name: "轻柔", exact: true }).click();
  await page.getByRole("button", { name: "关闭画面设置", exact: true }).click();
  const gentle = await playThrough(1, 6.9);
  const gentleHits = report(gentle.samples, referenceHits.filter((time) => time >= 2));
  expect(gentleHits.reduce((sum, f) => sum + f.contrast, 0)).toBeLessThan(vividHits.filter((f) => f.hit >= 2).reduce((sum, f) => sum + f.contrast, 0) * .8);

  await page.getByRole("button", { name: "画面设置", exact: true }).click();
  await page.getByRole("button", { name: "鲜明", exact: true }).click();
  await page.getByRole("button", { name: "关闭画面设置", exact: true }).click();
  await page.getByRole("button", { name: "氛围静音", exact: true }).click();
  const muted = await playThrough(1, 4.4);
  const mutedHits = report(muted.samples, referenceHits.filter((time) => time >= 2 && time <= 4));
  expect(await page.evaluate(() => (window as unknown as ObservedWindow).soundProbe.gain!.gain.value)).toBeLessThan(.001);
  for (const hit of mutedHits) expect(hit.contrast).toBeGreaterThan(1.65);
  fs.writeFileSync(info.outputPath("beat-strength-and-mute.json"), JSON.stringify({ gentleHits, mutedHits }, null, 2));

  // 拖动到持续低音中间不能把寻址边缘误当成敲击。
  const jumped = await playThrough(9, 10.5);
  const startup = jumped.samples.filter((f) => f.time >= 9 && f.time <= 9.3).map(brightest);
  const stable = jumped.samples.filter((f) => f.time >= 10 && f.time <= 10.4).map(brightest);
  expect(Math.max(...startup)).toBeLessThan(Math.max(...stable) * 1.2);
  fs.writeFileSync(info.outputPath("seek-into-sustain.json"), JSON.stringify(jumped.samples, null, 2));
  await page.getByRole("button", { name: "灯光编排", exact: true }).click();
  await page.getByRole("button", { name: "节拍接力", exact: true }).click();
  const relay = await playThrough(1, 4.4);
  const group = (sample: LightSample) => sample.power.slice(0, 8).indexOf(Math.max(...sample.power.slice(0, 8))) % 4;
  const groups = referenceHits.filter((t) => t >= 2 && t <= 4).map((hit) => {
    const peak = relay.samples.filter((f) => f.time >= hit && f.time < hit + .15).sort((a, b) => brightest(b) - brightest(a))[0];
    return group(peak);
  });
  expect(new Set(groups).size).toBeGreaterThanOrEqual(3);
  const held = await playThrough(9, 10.5);
  expect(new Set(held.samples.filter((f) => f.time > 9.4).map(group)).size).toBe(1);
  fs.writeFileSync(info.outputPath("beat-relay.json"), JSON.stringify({ groups, samples: relay.samples, sustained: held.samples }, null, 2));
});

test("播放页同步正式版的转换提示、错误反馈与无歌词状态", async ({ page }, info) => {
  for (const [layout, width, height] of [["desktop", 1440, 900], ["mobile", 393, 852]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/#/preview/player-transcoding");
    await page.getByRole("button", { name: /^打开沉浸播放器/ }).click();
    const player = page.getByRole("dialog", { name: "沉浸播放器" });
    await expect(player.locator(".np-play")).toBeDisabled();
    await expect(player.locator(".playback-feedback")).toHaveCount(0);
    await expect(player.locator(".np-quality")).toHaveText("原创演示音源 · 非本曲音频");
    await page.screenshot({ path: info.outputPath(`transcoding-${layout}.png`) });
    await player.getByRole("button", { name: "进入氛围模式", exact: true }).click();
    await expect(player.getByRole("button", { name: "氛围正在准备音频", exact: true })).toBeDisabled();
    await expect(player.locator(".playback-feedback")).toHaveCount(0);
    await expect(player.getByRole("slider", { name: "氛围播放进度", exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath(`atmosphere-transcoding-${layout}.png`) });

    await page.goto("/#/preview/player-offline");
    await page.getByRole("button", { name: /^打开沉浸播放器/ }).click();
    await expect(player.locator(".playback-feedback")).toContainText("与音乐室的连接中断了");
    await expect(player.getByRole("button", { name: "重新连接", exact: true })).toBeVisible();
    await player.getByRole("button", { name: "进入氛围模式", exact: true }).click();
    await expect(player.locator(".playback-feedback")).toContainText("与音乐室的连接中断了");
    await player.getByRole("button", { name: "重新连接", exact: true }).click();
    await expect(player.locator(".playback-feedback")).toHaveCount(0);
    await expect.poll(() => playing(page)).toBe(true);

    await page.goto("/#/preview/lyrics-loading");
    await expect(player.getByText("正在加载歌词…", { exact: true })).toBeVisible();
    await player.getByRole("button", { name: "进入氛围模式", exact: true }).click();
    await expect(player.getByText("正在加载歌词…", { exact: true })).toBeVisible();
    await expect(player.getByText("音乐会继续播放，请稍等片刻。", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`lyrics-loading-${layout}.png`) });
    await page.goto("/#/preview/lyrics-empty");
    await expect(player.getByText("暂时没有找到匹配的歌词", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`lyrics-empty-${layout}.png`) });
    await player.getByRole("button", { name: "重新查找歌词", exact: true }).click();
    await expect(player.getByText("正在加载歌词…", { exact: true })).toBeVisible();
    await expect(player.getByText("音乐会继续播放，请稍等片刻。", { exact: true })).toHaveCount(0);
    await expect(player.getByText("原创演示 · 非本曲歌词", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`lyrics-ready-${layout}.png`) });
  }
});

test("原型歌词同步正式版逐行规则，暂停、跳转、跟随和切歌保持正确", async ({ page }, info) => {
  test.setTimeout(60_000);
  for (const [layout, width, height] of [["desktop", 1280, 900], ["mobile", 393, 852]] as const) {
    await page.setViewportSize({ width, height });
    if (layout === "mobile") await page.reload();
    await page.goto("/#/playing");
    const player = page.getByRole("dialog", { name: "沉浸播放器" });
    await expect(player.getByRole("button", { name: "播放", exact: true })).toBeEnabled();
    await player.getByRole("button", { name: "歌词", exact: true }).click();
    await expect(player.getByText("原创演示 · 非本曲歌词", { exact: true })).toBeVisible();
    // 只有行时间的示例不能再把整句均分给各字，冒充逐词时间。
    await expect(player.locator(".np-lyric-word")).toHaveCount(0);
    const lines = player.getByRole("button", { name: /^跳转到 / });
    const labels = await lines.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")!));
    const current = player.locator(".np-lyric-line.is-current");
    await lines.first().click();
    await expect(current).toHaveAttribute("aria-label", labels[0]);
    await expect(player.getByRole("slider", { name: "播放进度", exact: true })).toHaveValue("0");
    await lines.nth(1).click();
    await expect(current).toHaveAttribute("aria-label", labels[1]);
    await player.getByRole("button", { name: "播放", exact: true }).click();
    await expect.poll(() => playing(page)).toBe(true);
    await player.getByRole("button", { name: "暂停", exact: true }).click();
    await expect.poll(() => playing(page)).toBe(false);
    const stopped = await current.getAttribute("aria-label");
    await page.waitForTimeout(300);
    await expect(current).toHaveAttribute("aria-label", stopped!);
    await player.getByRole("button", { name: "进入氛围模式", exact: true }).click();
    await expect(current).toHaveAttribute("aria-label", stopped!);
    await expect(player.locator(".np-lyric-word")).toHaveCount(0);
    const toolbar = player.locator(".np-lyrics-toolbar");
    const lyricsToggle = player.getByRole("button", { name: "氛围歌词", exact: true });
    await expect(toolbar).toHaveCount(1);
    await expect(toolbar).toHaveText("");
    await expect(player.getByRole("button", { name: "收起歌词", exact: true })).toHaveCount(0);
    await expect(player.getByText("点击播放，查看歌词动效", { exact: true })).toHaveCount(0);
    await lyricsToggle.click();
    await expect(player.getByRole("complementary", { name: "氛围歌词面板" })).toHaveCount(0);
    await lyricsToggle.click();
    await expect(current).toHaveAttribute("aria-label", stopped!);
    await lines.nth(2).click();
    await expect(current).toHaveAttribute("aria-label", labels[2]);
    await player.locator(".np-lyrics-scroll").hover();
    await page.mouse.wheel(0, 350);
    await expect(player.getByRole("button", { name: "回到当前歌词", exact: true })).toBeVisible();
    const returnBounds = await player.getByRole("button", { name: "回到当前歌词", exact: true }).boundingBox();
    const lyricBounds = await player.locator(".np-lyrics-scroll").boundingBox();
    expect(Math.abs(returnBounds!.x + returnBounds!.width / 2 - lyricBounds!.x - lyricBounds!.width / 2)).toBeLessThan(1);
    await player.getByRole("button", { name: "回到当前歌词", exact: true }).click();
    await expect(player.locator(".np-synced-lyrics")).toHaveClass(/is-following/);
    await expect(current).toBeInViewport();
    // 暂停浏览后，播放手势应恢复跟随；不依赖下一句歌词触发归位。
    await player.locator(".np-lyrics-scroll").hover();
    await page.mouse.wheel(0, 500);
    await expect(player.getByRole("button", { name: "回到当前歌词", exact: true })).toBeVisible();
    await player.getByRole("button", { name: "氛围播放", exact: true }).click();
    await expect.poll(() => playing(page)).toBe(true);
    await expect(player.getByRole("button", { name: "回到当前歌词", exact: true })).toHaveCount(0, { timeout: 1000 });
    await expect(current).toBeInViewport();
    await player.getByRole("button", { name: "氛围暂停", exact: true }).click();
    await lines.nth(2).click();
    await page.screenshot({ path: info.outputPath(`line-lyrics-atmosphere-${layout}.png`) });
    await player.getByRole("button", { name: "返回播放页", exact: true }).click();
    await expect(current).toHaveAttribute("aria-label", labels[2]);
    await player.getByRole("button", { name: "下一首", exact: true }).click();
    await expect(player.getByRole("button", { name: "暂停", exact: true })).toBeEnabled();
    await player.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(current).toHaveAttribute("aria-label", labels[0]);
    await expect(player.locator(".np-lyric-word")).toHaveCount(0);
    await expect(current.locator(".np-lyric-text")).toHaveCSS("filter", "blur(0px)");
    await page.screenshot({ path: info.outputPath(`line-lyrics-normal-${layout}.png`) });
  }
});

test("原型设置同步 NAS 直连开关、检测状态与取消行为", async ({ page }, info) => {
  for (const [layout, width, height] of [["desktop", 1280, 900], ["mobile", 393, 852]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/#/songs");
    if (layout === "mobile") await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "音乐室设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "音乐室设置", exact: true });
    const automatic = settings.getByRole("switch", { name: "优先 NAS 直连", exact: true });
    const retry = settings.getByRole("button", { name: "重新检测直连", exact: true });
    const status = settings.getByTestId("media-connection-status");
    await expect(automatic).toBeChecked();
    await expect(status).toHaveText("NAS 直连可用");
    await retry.click();
    await expect(status).toHaveText("正在检测直连…");
    await expect(retry).toBeDisabled();
    await automatic.click();
    await expect(status).toHaveText("仅使用公网中转");
    // 检测中的关闭必须取消晚到的模拟结果，不能重新打开用户已关掉的选项。
    await page.waitForTimeout(1000);
    await expect(automatic).not.toBeChecked();
    await expect(status).toHaveText("仅使用公网中转");
    await expect(retry).toBeDisabled();
    await page.screenshot({ path: info.outputPath(`media-connection-public-${layout}.png`) });
    await automatic.click();
    await expect(status).toHaveText("正在检测直连…");
    await expect(status).toHaveText("NAS 直连可用");
    await expect(retry).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`media-connection-direct-${layout}.png`) });
    await settings.getByRole("button", { name: "关闭对话框", exact: true }).click();
  }
});

test("播放进度在手势结束后提交，切歌不带入旧进度", async ({ page }, info) => {
  await page.goto("/#/playing");
  const player = page.getByRole("dialog", { name: "沉浸播放器" });
  const slider = player.getByRole("slider", { name: "播放进度", exact: true });
  await expect(slider).toBeEnabled();
  const displayedTime = player.locator(".np-progress > div > span").first();
  const initialTime = await displayedTime.innerText();
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width * .25, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .65, box.y + box.height / 2, { steps: 8 });
  const target = Number(await slider.inputValue());
  expect(target).toBeGreaterThan(38);
  await expect(displayedTime).toHaveText(initialTime);
  await page.screenshot({ path: info.outputPath("seek-preview-desktop.png") });
  await page.mouse.up();
  const targetTime = `${Math.floor(target / 60)}:${String(target % 60).padStart(2, "0")}`;
  await expect(displayedTime).toHaveText(targetTime);
  await slider.focus();
  await page.keyboard.down("ArrowLeft");
  await expect(slider).toHaveValue(String(target - 1));
  await expect(displayedTime).toHaveText(targetTime);
  await page.keyboard.up("ArrowLeft");
  await expect(displayedTime).not.toHaveText(targetTime);

  await player.getByRole("button", { name: "收起播放器", exact: true }).click();
  await expect(player).toHaveCount(0);
  const capsule = page.getByRole("contentinfo", { name: "底部播放器" });
  const miniSlider = capsule.getByRole("slider", { name: "播放进度", exact: true });
  const miniTime = capsule.locator(".current-time");
  const before = await miniTime.innerText();
  await miniSlider.focus();
  await expect(miniSlider).toBeFocused();
  await page.keyboard.down("Home");
  await expect(miniSlider).toHaveValue("0");
  await expect(miniTime).toHaveText(before);
  await page.keyboard.up("Home");
  await expect(miniTime).toHaveText("0:00");
  await page.screenshot({ path: info.outputPath("seek-capsule-desktop.png") });
  await page.keyboard.down("End");
  await capsule.getByRole("button", { name: "下一首", exact: true }).click();
  await page.keyboard.up("End");
  await expect(miniSlider).toBeEnabled();
  expect(Number(await miniSlider.inputValue())).toBeLessThan(3);
  await capsule.getByRole("button", { name: "暂停", exact: true }).click();

  await page.setViewportSize({ width: 393, height: 852 });
  await capsule.getByRole("button", { name: /^打开沉浸播放器/ }).click();
  await slider.press("Home");
  await page.keyboard.down("ArrowRight");
  await expect(slider).toHaveValue("1");
  await expect(displayedTime).toHaveText("0:00");
  await page.keyboard.up("ArrowRight");
  await expect(displayedTime).toHaveText("0:01");
  await expect(player).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("seek-mobile.png"), animations: "disabled" });
});

test("三种主题使用真实声音，切换、暂停、跳转和退出保持连续", async ({ page }, info) => {
  await enter(page);
  await page.getByRole("button", { name: "氛围播放", exact: true }).click();
  await expect.poll(() => playing(page)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as ObservedWindow).soundProbe.nonzero)).toBeGreaterThan(5);
  for (const [name, id] of [["雾中侧光", "geometry"], ["逆光开场", "particles"], ["灯阵呼吸", "fluid"]]) {
    const before = Number(await page.getByLabel("氛围播放进度", { exact: true }).inputValue());
    await page.getByRole("button", { name: "灯光编排", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("region", { name: "氛围模式", exact: true })).toHaveAttribute("data-theme", id);
    expect(await playing(page)).toBe(true);
    expect(Number(await page.getByLabel("氛围播放进度", { exact: true }).inputValue())).toBeGreaterThanOrEqual(before);
    const firstFrame = await visualFrame(page);
    await page.waitForTimeout(350);
    expect((await visualFrame(page)).equals(firstFrame)).toBe(false);
    await page.screenshot({ path: info.outputPath(`${id}-desktop.png`), animations: "disabled" });
  }
  await page.getByRole("button", { name: "进入全屏", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains("atmosphere-mode") ?? false)).toBe(true);
  await page.getByRole("button", { name: "退出全屏", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await page.getByRole("button", { name: "灯光编排", exact: true }).click();
  await page.getByRole("button", { name: "雾中侧光", exact: true }).click();
  await page.getByRole("button", { name: "氛围暂停", exact: true }).click();
  await expect.poll(() => playing(page)).toBe(false);
  await page.waitForTimeout(800);
  const image = await visualFrame(page);
  await page.waitForTimeout(250);
  expect((await visualFrame(page)).equals(image)).toBe(true);
  const progress = page.getByLabel("氛围播放进度", { exact: true });
  await progress.press("Home");
  for (let i = 0; i < 12; i++) await progress.press("ArrowRight");
  expect(Number(await progress.inputValue())).toBe(12);
  await expect.poll(() => page.locator("audio").evaluate((element) => (element as HTMLAudioElement).currentTime)).toBeCloseTo(12, 0);
  await page.getByRole("button", { name: "氛围播放", exact: true }).click();
  const heading = await page.locator(".av-now h1").innerText();
  await page.getByRole("button", { name: "氛围下一首", exact: true }).click();
  await expect(page.locator(".av-now h1")).not.toHaveText(heading);
  await expect.poll(() => playing(page)).toBe(true);
  await page.getByRole("button", { name: "氛围静音", exact: true }).click();
  await expect(page.getByLabel("氛围音量", { exact: true })).toHaveValue("0");
  await expect.poll(() => page.evaluate(() => (window as unknown as ObservedWindow).soundProbe.gain?.gain.value ?? -1)).toBeLessThan(.001);
  await page.getByRole("button", { name: "氛围恢复音量", exact: true }).click();
  await expect(page.getByLabel("氛围音量", { exact: true })).toHaveValue("70");
  await page.getByRole("button", { name: "返回播放页", exact: true }).click();
  await expect(page.getByRole("button", { name: "进入氛围模式", exact: true })).toBeFocused();
  expect(await playing(page)).toBe(true);
  await expect(page.getByRole("dialog", { name: "沉浸播放器" }).getByRole("button", { name: "暂停", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "进入氛围模式", exact: true }).click();
  await expect.poll(() => playing(page)).toBe(true);
  await expect(page.locator("audio")).toHaveCount(1);
});

for (const mobile of [false, true]) test.describe(mobile ? "手机浮窗" : "桌面浮窗", () => {
  test.use({ viewport: mobile ? { width: 393, height: 852 } : { width: 1108, height: 879 }, hasTouch: mobile });
  test("氛围浮窗点击外部关闭，内部操作与入口切换不误触", async ({ page }, info) => {
    await enter(page);
    const activate = async (name: string) => {
      const button = page.getByRole("button", { name, exact: true });
      if (mobile) await button.tap(); else await button.click();
    };
    const outside = async () => {
      const bounds = (await page.locator(".av-picker, .av-settings").boundingBox())!;
      const point = { x: Math.min(12, bounds.x / 2), y: bounds.y + bounds.height / 2 };
      if (mobile) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
    };
    const looks = page.getByRole("complementary", { name: "灯光编排面板" });
    const settings = page.getByRole("complementary", { name: "画面设置面板" });
    const lyrics = page.getByRole("complementary", { name: "氛围歌词面板" });
    await activate("氛围播放");
    await expect.poll(() => playing(page)).toBe(true);
    await activate("氛围歌词");
    await activate("灯光编排");
    await expect(looks).toBeVisible();
    await page.getByText("给这一刻，换一场灯光", { exact: true }).click();
    await expect(looks).toBeVisible();
    if (!mobile) {
      await looks.hover(); await page.mouse.wheel(0, 180);
      await expect.poll(() => looks.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
      await expect(looks).toBeVisible();
    }
    const source = await page.locator("audio").evaluate((node) => (node as HTMLAudioElement).currentSrc);
    const stage = await page.locator(".av-visual").boundingBox();
    await page.screenshot({ path: info.outputPath("outside-before.png") });
    await outside();
    await expect(looks).toHaveCount(0);
    await expect(page.getByRole("button", { name: "灯光编排", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(lyrics).toBeVisible();
    expect(await page.locator(".av-visual").boundingBox()).toEqual(stage);
    expect(await playing(page)).toBe(true);
    expect(await page.locator("audio").evaluate((node) => (node as HTMLAudioElement).currentSrc)).toBe(source);
    await page.screenshot({ path: info.outputPath("outside-after.png") });

    // 入口必须一次就能开关，不能因外侧 pointerdown 和按钮 click 各处理一次而重开。
    await activate("灯光编排"); await activate("灯光编排");
    await expect(looks).toHaveCount(0);
    await activate("灯光编排"); await activate("花影流转");
    await expect(looks).toHaveCount(0);
    await expect(page.locator(".atmosphere-mode")).toHaveAttribute("data-theme", "petals");

    // 相邻浮窗使用同一外侧关闭规则，切到另一入口仍只执行一次。
    await activate("灯光编排"); await activate("画面设置");
    await expect(looks).toHaveCount(0); await expect(settings).toBeVisible();
    await activate("暗红");
    await expect(settings).toBeVisible();
    await expect(page.locator(".atmosphere-mode")).toHaveClass(/palette-ember/);
    await outside(); await expect(settings).toHaveCount(0);
    await activate("画面设置"); await activate("画面设置");
    await expect(settings).toHaveCount(0);
    await activate("画面设置");
    // 手机设置浮窗覆盖导航，先点外侧回到舞台，再使用可见入口。
    if (mobile) { await outside(); await expect(settings).toHaveCount(0); }
    await activate("灯光编排");
    await expect(settings).toHaveCount(0); await expect(looks).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(looks).toHaveCount(0); await expect(lyrics).toBeVisible();
    expect(await playing(page)).toBe(true);

    await activate("画面设置"); await activate("氛围暂停");
    await expect(settings).toHaveCount(0);
    await expect.poll(() => playing(page)).toBe(false);
    await expect(page.getByRole("button", { name: "氛围播放", exact: true })).toBeVisible();
  });
});

test("氛围面板轻柔开关，舞台与控件不位移，快速互切和键盘关闭保持连续", async ({ page }, info) => {
  test.setTimeout(60_000);
  for (const [layout, width, height] of [["desktop", 1280, 900], ["mobile", 393, 852]] as const) {
    await page.setViewportSize({ width, height });
    if (layout === "mobile") await page.reload();
    await enter(page);
    await page.getByRole("button", { name: "氛围播放", exact: true }).click();
    await expect.poll(() => playing(page)).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as ObservedWindow).soundProbe.nonzero)).toBeGreaterThan(5);
    await observePanels(page);
    const lyrics = page.getByRole("complementary", { name: "氛围歌词面板" });
    const queue = page.getByRole("complementary", { name: "氛围待播面板" });
    const lyricButton = page.getByRole("button", { name: "氛围歌词", exact: true });
    const queueButton = page.getByRole("button", { name: "氛围待播清单", exact: true });
    await lyricButton.click();
    await expect(lyrics).toHaveCSS("opacity", "1");
    await page.screenshot({ path: info.outputPath(`floating-lyrics-${layout}.png`) });
    await queueButton.click();
    await expect(queue).toHaveCSS("opacity", "1");
    await expect(lyrics).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`floating-queue-${layout}.png`) });
    await page.getByRole("button", { name: "收起待播清单", exact: true }).click();
    await expect(page.locator(".av-companion")).toHaveCount(0);
    const frames = await finishPanelObservation(page);
    fs.writeFileSync(info.outputPath(`panel-motion-${layout}.json`), JSON.stringify(frames, null, 2));
    const first = frames[0];
    expect(frames.length).toBeGreaterThan(12);
    for (const frame of frames) {
      expect(frame.stage).toEqual(first.stage);
      expect(frame.canvas).toEqual(first.canvas);
      expect(frame.footer).toEqual(first.footer);
      expect(frame.nav).toEqual(first.nav);
      expect(frame.stageOpacity).toBe(1);
      expect(frame.playing).toBe(true);
    }
    // 进入与离开都存在中间透明度，排除硬切或仅给入场加动画。
    for (const label of ["氛围歌词面板", "氛围待播面板"]) {
      const alpha = frames.flatMap((frame) => frame.panels.filter((panel) => panel.label === label).map((panel) => panel.opacity));
      expect(alpha.some((value) => value > .05 && value < .95)).toBe(true);
      const peak = alpha.findIndex((value) => value >= .99);
      expect(peak).toBeGreaterThanOrEqual(0);
      expect(alpha.slice(peak + 1).some((value) => value > .02 && value < .95)).toBe(true);
    }
    await expect(queueButton).toBeFocused();
    await lyricButton.click(); await queueButton.click(); await lyricButton.click();
    await expect(lyrics).toHaveCSS("opacity", "1");
    await expect(page.locator(".av-companion")).toHaveCount(1);
    await expect(queue).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(lyricButton).toBeFocused();
    await expect(page.locator(".av-companion")).toHaveCount(0);
    // 关闭后的歌词/队列不能留在键盘或辅助功能导航中。
    await expect(page.getByRole("button", { name: /^跳转到 / })).toHaveCount(0);
    expect(await playing(page)).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "氛围歌词", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "氛围歌词面板" })).toHaveCSS("opacity", "1");
  expect(await page.locator(".av-companion").evaluate((node) => node.getAnimations().filter((animation) => animation.playState === "running").length)).toBe(0);
  await page.getByRole("button", { name: "氛围歌词", exact: true }).click();
  await expect(page.locator(".av-companion")).toHaveCount(0);
});

test("歌词、队列、设置与 Escape 按层关闭并恢复原播放页", async ({ page }, info) => {
  await page.goto("/#/playing");
  await page.getByRole("dialog", { name: "沉浸播放器" }).getByRole("button", { name: "歌词", exact: true }).click();
  await page.getByRole("button", { name: "进入氛围模式", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "氛围歌词面板" })).toBeVisible();
  const line = page.getByRole("button", { name: /^跳转到 / }).nth(1);
  const timestamp = (await line.getAttribute("aria-label"))!.match(/跳转到 (\d+):(\d+)/)!;
  const seconds = Number(timestamp[1]) * 60 + Number(timestamp[2]);
  await line.click();
  await expect(page.getByRole("slider", { name: "氛围播放进度", exact: true })).toHaveValue(String(seconds));
  await expect.poll(() => page.locator("audio").evaluate((node) => (node as HTMLAudioElement).currentTime)).toBeCloseTo(seconds, 0);
  await page.getByRole("button", { name: "画面设置", exact: true }).click();
  await page.getByRole("button", { name: "暗红", exact: true }).click();
  await page.getByRole("button", { name: "轻柔", exact: true }).click();
  await expect(page.locator(".atmosphere-mode")).toHaveClass(/palette-ember/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "画面设置面板" })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "氛围歌词面板" })).toBeVisible();
  await page.getByRole("button", { name: "氛围待播清单", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "氛围待播面板" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("queue-desktop.png") });
  await page.keyboard.press("Escape");
  await expect(page.locator(".av-companion")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "进入氛围模式", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "沉浸播放器" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "沉浸播放器" }).getByRole("button", { name: "歌词", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "进入氛围模式", exact: true }).click();
  await expect(page.locator(".atmosphere-mode")).toHaveClass(/palette-ember/);
  await page.getByRole("button", { name: "画面设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "轻柔", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("闲置隐藏控制，指针与键盘唤回，暂停时保持可用", async ({ page }, info) => {
  await enter(page);
  await page.getByRole("button", { name: "氛围播放", exact: true }).click();
  await page.getByRole("button", { name: "氛围歌词", exact: true }).click();
  await page.mouse.click(250, 400);
  await expect(page.locator(".av-header")).toHaveCSS("opacity", "0", { timeout: 7000 });
  await expect(page.getByRole("complementary", { name: "氛围歌词面板" })).toHaveCSS("opacity", "1");
  await expect(page.locator(".np-lyric-line.is-current")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("lyrics-without-controls.png") });
  await page.mouse.move(260, 410);
  await expect(page.locator(".av-header")).toHaveCSS("opacity", "1");
  await page.mouse.click(250, 400);
  await expect(page.locator(".av-header")).toHaveCSS("opacity", "0", { timeout: 7000 });
  await page.keyboard.press("Tab");
  await expect(page.locator(".av-header")).toHaveCSS("opacity", "1");
  await page.getByRole("button", { name: "氛围暂停", exact: true }).click();
  await page.waitForTimeout(5000);
  await expect(page.locator(".av-header")).toHaveCSS("opacity", "1");
});

test("手机三主题、歌词、队列和设置保持可操作且无横向溢出", async ({ page }, info) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await enter(page);
  await page.getByRole("button", { name: "氛围播放", exact: true }).click();
  await expect.poll(() => playing(page)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as ObservedWindow).soundProbe.nonzero)).toBeGreaterThan(5);
  for (const name of ["雾中侧光", "逆光开场", "灯阵呼吸"]) {
    await page.getByRole("button", { name: "灯光编排", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await page.screenshot({ path: info.outputPath(`${name}-mobile.png`), animations: "disabled" });
  }
  await page.getByRole("button", { name: "氛围歌词", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "氛围歌词面板" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("lyrics-mobile.png") });
  await page.getByRole("button", { name: "氛围待播清单", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "氛围待播面板" })).toHaveCSS("opacity", "1");
  const queueTitles = page.locator(".av-companion-queue .np-queue-select strong");
  const before = await queueTitles.allTextContents();
  expect(before.length).toBeGreaterThan(2);
  await page.getByRole("button", { name: `编辑待播歌曲 ${before[0]}`, exact: true }).click();
  await page.getByRole("button", { name: `下移 ${before[0]}`, exact: true }).click();
  await expect(queueTitles).toHaveText([before[1], before[0], ...before.slice(2)]);
  await page.screenshot({ path: info.outputPath("queue-edit-mobile.png") });
  await page.getByRole("button", { name: `移除 ${before[0]}`, exact: true }).click();
  await expect(queueTitles).toHaveText(before.slice(1));
  expect(await playing(page)).toBe(true);
  await page.screenshot({ path: info.outputPath("queue-mobile.png") });
  await page.getByRole("button", { name: "收起待播清单", exact: true }).click();
  await page.getByRole("button", { name: "画面设置", exact: true }).click();
  await page.getByRole("button", { name: "深蓝", exact: true }).click();
  await page.getByRole("button", { name: "关闭画面设置", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await page.locator(".av-controls").evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: info.outputPath("compact-mobile.png") });
  for (const [name, panelName, file] of [["氛围歌词", "氛围歌词面板", "lyrics"], ["氛围待播清单", "氛围待播面板", "queue"]] as const) {
    await page.getByRole("button", { name, exact: true }).click();
    const panel = page.getByRole("complementary", { name: panelName });
    await expect(panel).toHaveCSS("opacity", "1");
    const bounds = (await panel.boundingBox())!;
    const footer = (await page.locator(".av-footer").boundingBox())!;
    const nav = (await page.locator(".av-theme-nav").boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    expect(bounds.y).toBeGreaterThanOrEqual(nav.y + nav.height);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(footer.y);
    await page.screenshot({ path: info.outputPath(`compact-${file}-mobile.png`) });
  }
});

test("减少动态效果保持静止，WebGL 不可用仍可观看灯光", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === "webgl") return null;
      return original.apply(this, [type, ...args] as Parameters<typeof original>);
    } as typeof original;
  });
  await enter(page);
  await page.getByRole("button", { name: "氛围播放", exact: true }).click();
  await expect.poll(() => playing(page)).toBe(true);
  const canvas = page.locator(".av-visual canvas").first();
  const image = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(300);
  expect(await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).toBe(image);
  await page.getByRole("button", { name: "灯光编排", exact: true }).click();
  await page.getByRole("button", { name: "灯阵呼吸", exact: true }).click();
  await expect(page.getByText("此设备使用简化画面")).toBeVisible();
  await page.screenshot({ path: info.outputPath("fluid-fallback.png") });
  for (const name of ["花影流转", "百叶光窗", "扇屏开合", "节拍接力"]) {
    await page.getByRole("button", { name: "灯光编排", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
    const frame = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
    await page.waitForTimeout(250);
    expect(await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).toBe(frame);
    await page.screenshot({ path: info.outputPath(`${name}-fallback.png`) });
  }
});

test("舞台灯光在减少动态效果与图形上下文丢失恢复后保持可观看", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enter(page);
  await page.getByRole("button", { name: "氛围播放", exact: true }).click();
  await expect.poll(() => playing(page)).toBe(true);
  for (const name of ["雾中侧光", "逆光开场", "灯阵呼吸", "花影流转", "百叶光窗", "扇屏开合", "节拍接力"]) {
    await page.getByRole("button", { name: "灯光编排", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".av-fallback")).toHaveCount(0);
    await expect(page.locator(".av-visual canvas").nth(1)).toBeVisible();
    const frame = await visualFrame(page);
    await page.waitForTimeout(250);
    expect((await visualFrame(page)).equals(frame)).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // 故障发生在真实 WebGL 边界，不修改场景或播放器内部状态。
  await page.evaluate(() => {
    const gl = document.querySelector<HTMLCanvasElement>(".av-visual canvas:nth-child(2)")!.getContext("webgl");
    const boundary = gl?.getExtension("WEBGL_lose_context");
    if (!boundary) throw new Error("测试浏览器缺少 WebGL 上下文故障注入边界");
    (window as unknown as ObservedWindow).graphicsBoundary = boundary;
    boundary.loseContext();
  });
  await expect(page.getByText("此设备使用简化画面")).toBeVisible();
  expect(await playing(page)).toBe(true);
  await page.screenshot({ path: info.outputPath("stage-context-lost.png"), animations: "disabled" });
  await page.waitForTimeout(550);
  await page.evaluate(() => (window as unknown as ObservedWindow).graphicsBoundary!.restoreContext());
  await expect(page.locator(".av-fallback")).toHaveCount(0);
  await expect(page.locator(".av-visual canvas").nth(1)).toBeVisible();
  const restored = await visualFrame(page);
  await page.waitForTimeout(350);
  expect((await visualFrame(page)).equals(restored)).toBe(false);
  await page.screenshot({ path: info.outputPath("stage-context-restored.png"), animations: "disabled" });
});

test("音源请求失败显示重试，恢复后实际输出声音", async ({ page }, info) => {
  await page.route("**/audio/atmosphere-demo.wav", (route) => route.abort());
  await enter(page);
  await page.getByRole("button", { name: "氛围播放", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试音频", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("audio-failure.png") });
  await page.unroute("**/audio/atmosphere-demo.wav");
  await page.getByRole("button", { name: "重试音频", exact: true }).click();
  await expect.poll(() => playing(page)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as ObservedWindow).soundProbe.nonzero)).toBeGreaterThan(5);
});
