import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { test, expect, titles } from "./helpers/room.js";

test.use({ roomOptions: { metadata: true, autoEnrich: false, onlineLyrics: true } });

test("打开歌词自动查询，查无结果后可刷新，成功持久化且不重复查询", async ({ page, room }, info) => {
  room.upstream.lyrics = "missing";
  await room.ready(page);
  const song = await room.track(page.request, titles.aac);
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  await player.getByRole("button", { name: "暂停", exact: true }).click();
  await player.getByRole("button", { name: /^打开沉浸播放器/ }).click();
  const full = page.getByRole("dialog", { name: "沉浸播放器" });
  await full.getByRole("button", { name: "歌词", exact: true }).click();
  await expect(full.getByText("暂时没有找到匹配的歌词", { exact: true })).toBeVisible();
  expect(room.upstream.requests.some((url) => new URL(url).hostname === "lrclib.net")).toBe(true);
  const before = room.upstream.requests.length;
  // 普通读取命中短期空结果；用户明确重查必须穿透缓存。
  expect((await page.request.get(`${room.url}/api/tracks/${song.id}/lyrics`)).status()).toBe(404);
  expect(room.upstream.requests).toHaveLength(before);
  room.upstream.lyrics = "found";
  await full.getByRole("button", { name: "重新查找歌词", exact: true }).click();
  await expect(full.getByRole("region", { name: "歌词", exact: true })).toContainText("在线测试歌词第一行");
  await expect(full.locator(".np-lyric-word")).toHaveCount(0);
  await expect(full.locator(".np-lyrics-toolbar")).toHaveText("逐行歌词");
  const db = new Database(path.join(room.data, "music-library.sqlite"), { readonly: true });
  try {
    const saved = db.prepare("SELECT lyrics_path FROM tracks WHERE id = ?").get(song.id) as { lyrics_path: string };
    expect(saved.lyrics_path.startsWith(room.data + path.sep)).toBe(true);
    expect(fs.readFileSync(saved.lyrics_path, "utf8")).toContain("在线测试歌词第一行");
    await info.attach("lyrics-cache.json", { body: JSON.stringify({ track: song.id, hasLyrics: true, relativePath: path.relative(room.data, saved.lyrics_path) }), contentType: "application/json" });
  } finally { db.close(); }
  const after = room.upstream.requests.length;
  await page.reload();
  await expect(full.getByRole("heading", { name: titles.aac, exact: true })).toBeVisible();
  await full.getByRole("button", { name: "歌词", exact: true }).click();
  await expect(full.getByRole("region", { name: "歌词", exact: true })).toContainText("在线测试歌词第一行");
  expect(room.upstream.requests).toHaveLength(after);
});

for (const format of ["aac", "alac"] as const) test(`${format.toUpperCase()} 真实逐词时间支持停顿、暂停、回拖、缓存重载及切歌降为逐句`, async ({ page, room }, info) => {
  room.upstream.lyricsfile = JSON.stringify({ version: "1.0", metadata: { title: titles[format], artist: "E2E 艺人 / Artist" },
    lines: [
      { text: "风 停了", start_ms: 1000, end_ms: 4500, words: [
        { text: "风 ", start_ms: 1000, end_ms: 1500 }, { text: "停了", start_ms: 3000, end_ms: 4500 }
      ] },
      { text: "雨来了", start_ms: 5000 }
    ] });
  await room.ready(page);
  await page.getByRole("button", { name: `播放 ${titles[format]}`, exact: true }).click();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  await player.getByRole("button", { name: "暂停", exact: true }).click();
  await player.getByRole("button", { name: /^打开沉浸播放器/ }).click();
  const full = page.getByRole("dialog", { name: "沉浸播放器" });
  await full.getByRole("button", { name: "歌词", exact: true }).click();
  await expect(full.locator(".np-lyrics-toolbar")).toHaveText("逐词歌词");
  const progress = full.getByRole("slider", { name: "播放进度", exact: true });
  await progress.press("Home");
  await expect(full.locator(".np-lyric-line.is-current")).toHaveCount(0);
  await progress.press("ArrowRight"); await progress.press("ArrowRight");
  const words = full.locator(".np-lyric-line.is-current .np-lyric-word");
  const fill = () => words.evaluateAll((elements) => elements.map((element) => parseFloat((element as HTMLElement).style.getPropertyValue("--word-fill"))));
  await expect.poll(fill).toEqual([100, 0]);
  await full.getByRole("button", { name: "播放", exact: true }).click();
  await expect.poll(async () => (await fill())[1], { intervals: [50] }).toBeGreaterThan(10);
  await full.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(progress).toBeEnabled();
  const stopped = await fill();
  await page.waitForTimeout(250);
  expect(await fill()).toEqual(stopped);
  // 原生进度滑块手势；不修改播放器状态或伪造媒体事件。
  await progress.press("Home"); await progress.press("ArrowRight"); await progress.press("ArrowRight");
  await expect.poll(fill).toEqual([100, 0]);
  await progress.press("ArrowRight"); await progress.press("ArrowRight");
  await expect.poll(async () => Math.round((await fill())[1])).toBe(67);
  await info.attach("real-word-timing.png", { body: await full.screenshot(), contentType: "image/png" });
  const before = room.upstream.requests.length;
  await expect.poll(async () => (await room.api(page.request, "/api/me")).preferences.position).toBe(4);
  await page.reload();
  await expect(full.getByRole("heading", { name: titles[format], exact: true })).toBeVisible();
  await full.getByRole("button", { name: "歌词", exact: true }).click();
  await expect.poll(async () => Math.round((await fill())[1])).toBe(67);
  expect(room.upstream.requests).toHaveLength(before);
  await full.getByRole("button", { name: "待播清单", exact: true }).click();
  await full.getByRole("button", { name: `播放 ${titles.flac}`, exact: true }).click();
  await full.getByRole("button", { name: "暂停", exact: true }).click();
  await full.getByRole("button", { name: "歌词", exact: true }).click();
  await expect(full.locator(".np-lyrics-toolbar")).toHaveText("逐行歌词");
  await progress.press("Home"); await progress.press("ArrowRight");
  await expect(full.locator(".np-lyric-line.is-current")).toContainText("第一句测试歌词");
  await expect(full.locator(".np-lyric-word")).toHaveCount(0);
  await info.attach("line-timing-fallback.png", { body: await full.screenshot(), contentType: "image/png" });
  expect(room.upstream.requests).toHaveLength(before);
});

test("歌词服务异常显示重试，恢复后成功，切歌仍优先使用本地歌词", async ({ page, room }) => {
  room.upstream.lyrics = "error";
  await room.ready(page);
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  await player.getByRole("button", { name: "暂停", exact: true }).click();
  await player.getByRole("button", { name: /^打开沉浸播放器/ }).click();
  const full = page.getByRole("dialog", { name: "沉浸播放器" });
  await full.getByRole("button", { name: "歌词", exact: true }).click();
  await expect(full.getByRole("alert")).toContainText("歌词暂时没有载入");
  room.upstream.lyrics = "found";
  await full.getByRole("button", { name: "重新载入歌词", exact: true }).click();
  await expect(full.getByRole("region", { name: "歌词", exact: true })).toContainText("在线测试歌词第一行");
  const before = room.upstream.requests.length;
  await full.getByRole("button", { name: "待播清单", exact: true }).click();
  await full.getByRole("button", { name: `播放 ${titles.flac}`, exact: true }).click();
  await full.getByRole("button", { name: "暂停", exact: true }).click();
  await full.getByRole("button", { name: "歌词", exact: true }).click();
  await expect(full.getByRole("region", { name: "歌词", exact: true })).toContainText("第一句测试歌词");
  expect(room.upstream.requests).toHaveLength(before);
});
