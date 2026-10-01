import { test, expect, titles } from "./helpers/room.js";
import { observeAtmosphere, soundSnapshot } from "./helpers/atmosphere-observation.js";

test.use({ reducedMotion: "no-preference", roomOptions: { audioDuration: 60 } });

// 长句、前奏和器乐间奏在 HTTP 边界固定；音频仍由独立曲库真实直传或转码。
const lines = [
  { time: 12, text: "第一句还在唱，恢复播放应立即回到这里" },
  { time: 24, end: 25, text: "间奏前的最后一句" },
  ...[36, 40, 44, 48, 50, 54, 57].map((time, index) => ({ time, text: `后面的第 ${index + 3} 句歌词` }))
];

for (const [format, atmosphere, width, height] of [["aac", false, 1280, 900], ["alac", true, 393, 852]] as const) {
  test(`${atmosphere ? "氛围" : "普通"} ${format.toUpperCase()} ${width} 暂停浏览后播放立即跟随，前奏间奏定位且播放中可自由浏览`, async ({ page, room }, info) => {
    await page.setViewportSize({ width, height });
    await observeAtmosphere(page);
    await room.ready(page);
    const track = await room.track(page.request, titles[format]);
    const fixtureLines = format === "alac" ? [
      { ...lines[0], words: [{ text: "第一句还在唱，", time: 12, end: 14 }, { text: "恢复播放应立即回到这里", time: 14, end: 24 }] },
      ...lines.slice(1)
    ] : lines;
    await page.route((url) => url.pathname === `/api/tracks/${track.id}/lyrics`, (route) => route.fulfill({ json: { lines: fixtureLines } }));
    await page.locator(".main-content .track-identity").filter({ hasText: titles[format] }).click();
    const capsule = page.getByRole("contentinfo", { name: "底部播放器" });
    await capsule.getByRole("button", { name: "暂停", exact: true }).click();
    await capsule.getByRole("button", { name: /^打开沉浸播放器/ }).click();
    const full = page.getByRole("dialog", { name: "沉浸播放器" });
    if (atmosphere) await full.getByRole("button", { name: "进入氛围模式", exact: true }).click();
    const panel = atmosphere ? full.getByRole("region", { name: "氛围模式", exact: true }) : full;
    await panel.getByRole("button", { name: atmosphere ? "氛围歌词" : "歌词", exact: true }).click();
    const play = panel.getByRole("button", { name: atmosphere ? "氛围播放" : "播放", exact: true });
    const pause = panel.getByRole("button", { name: atmosphere ? "氛围暂停" : "暂停", exact: true });
    const progress = panel.getByRole("slider", { name: atmosphere ? "氛围播放进度" : "播放进度", exact: true });
    const scroller = panel.getByLabel("可滚动歌词，点击任一句跳转播放进度", { exact: true });
    const lyricLines = panel.locator(".np-lyric-line");
    const returnToLyrics = panel.getByRole("button", { name: "回到当前歌词", exact: true });
    const geometry = (index: number) => scroller.evaluate((element, lineIndex) => {
      const viewport = element.getBoundingClientRect();
      const line = element.querySelectorAll(".np-lyric-line")[lineIndex].getBoundingClientRect();
      return { scrollTop: element.scrollTop, distance: Math.abs(line.top + line.height / 2 - viewport.top - element.clientHeight * .4) };
    }, index);
    const evidence: Record<string, unknown> = { format, atmosphere, viewport: { width, height }, lines: fixtureLines };

    await expect(lyricLines).toHaveCount(lines.length);
    await lyricLines.nth(0).click();
    await expect(progress).toHaveValue("12");
    await expect(progress).toBeEnabled();
    await scroller.press("End");
    await expect(returnToLyrics).toBeVisible();
    await expect.poll(async () => (await geometry(0)).distance).toBeGreaterThan(150);
    // 暂停时浏览，再在同一句范围内调整音频进度，不能靠切换到下一句才重新定位。
    await progress.press("ArrowRight");
    await expect(progress).toHaveValue("13");
    await expect(progress).toBeEnabled();
    expect((await soundSnapshot(page)).paused).toBe(true);
    if (format === "alac") {
      await expect.poll(() => panel.locator(".np-lyric-word").evaluateAll((words) => words.map((word) => Math.round(parseFloat((word as HTMLElement).style.getPropertyValue("--word-fill")))))).toEqual([50, 0]);
    }
    evidence.pausedBrowsing = { geometry: await geometry(0), sound: await soundSnapshot(page) };
    await info.attach("paused-browsing.png", { body: await panel.screenshot(), contentType: "image/png" });
    await play.click();
    await expect(pause).toBeVisible();
    const started = Date.now();
    await expect(returnToLyrics).toHaveCount(0, { timeout: 1000 });
    await expect.poll(async () => (await geometry(0)).distance, { timeout: 1000 }).toBeLessThan(3);
    expect(Number(await progress.inputValue())).toBeLessThan(24);
    expect((await soundSnapshot(page)).paused).toBe(false);
    evidence.resumed = { elapsedMs: Date.now() - started, geometry: await geometry(0), progress: await progress.inputValue(), sound: await soundSnapshot(page) };
    await info.attach("resumed-following.png", { body: await panel.screenshot(), contentType: "image/png" });

    // 已经播放时主动浏览，真实音频继续前进，但不能每次时间更新都抢回滚动位置。
    await scroller.press("End");
    await expect(returnToLyrics).toBeVisible();
    const browsingTime = (await soundSnapshot(page)).time!;
    await expect.poll(async () => (await soundSnapshot(page)).time!).toBeGreaterThan(browsingTime + .4);
    await expect(returnToLyrics).toBeVisible();
    expect((await geometry(0)).distance).toBeGreaterThan(150);
    await pause.click();

    // 间奏不应高亮已唱完的歌词，也不能因为没有当前行而停在用户浏览的位置或跳回开头。
    await lyricLines.nth(1).click();
    await expect(progress).toHaveValue("24");
    for (let step = 0; step < 2; step++) { await expect(progress).toBeEnabled(); await progress.press("ArrowRight"); }
    await expect(progress).toHaveValue("26");
    await expect(progress).toBeEnabled();
    await expect(panel.locator(".np-lyric-line.is-current")).toHaveCount(0);
    await scroller.press("End");
    await expect(returnToLyrics).toBeVisible();
    await expect.poll(async () => (await geometry(1)).distance).toBeGreaterThan(150);
    await play.click();
    await expect(pause).toBeVisible();
    await expect(returnToLyrics).toHaveCount(0, { timeout: 1000 });
    await expect.poll(async () => (await geometry(1)).distance, { timeout: 1000 }).toBeLessThan(3);
    await expect(panel.locator(".np-lyric-line.is-current")).toHaveCount(0);
    evidence.interlude = { geometry: await geometry(1), progress: await progress.inputValue() };
    await pause.click();

    // 前奏也应马上回到开头，不能一直等到第一句的 12 秒时间点。
    await scroller.press("End");
    await expect(returnToLyrics).toBeVisible();
    await expect(progress).toBeEnabled();
    await progress.press("Home");
    await expect(progress).toHaveValue("0");
    await expect(progress).toBeEnabled();
    await expect.poll(async () => (await geometry(0)).scrollTop).toBeGreaterThan(150);
    await play.click();
    await expect(pause).toBeVisible();
    await expect(returnToLyrics).toHaveCount(0, { timeout: 1000 });
    await expect.poll(async () => (await geometry(0)).scrollTop, { timeout: 1000 }).toBeLessThan(1);
    await expect(panel.locator(".np-lyric-line.is-current")).toHaveCount(0);
    expect(Number(await progress.inputValue())).toBeLessThan(12);
    evidence.intro = { geometry: await geometry(0), progress: await progress.inputValue(), sound: await soundSnapshot(page) };
    await info.attach("intro-following.png", { body: await panel.screenshot(), contentType: "image/png" });
    await pause.click();
    await info.attach("lyrics-following.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  });
}
