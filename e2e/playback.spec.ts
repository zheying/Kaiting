import { test, expect, titles } from "./helpers/room.js";
import fs from "node:fs";

for (const format of ["aac", "alac", "flac"] as const) {
  test(`${format.toUpperCase()} 实际播放、暂停 seek、自然结束和刷新后从零重播`, async ({ page, room }, info) => {
    await room.ready(page);
    const song = await room.track(page.request, titles[format]);
    const streams: { url: string; mime: string; status: number }[] = [];
    page.on("response", (response) => { if (response.url().includes(`/api/tracks/${song.id}/stream`)) streams.push({ url: response.url(), mime: response.headers()["content-type"], status: response.status() }); });
    // 只留下所选格式的队列，让自然结束能保留完成状态。
    await page.getByRole("button", { name: format === "aac" ? "M4A" : format.toUpperCase(), exact: true }).click();
    await page.getByRole("button", { name: `播放 ${titles[format]}`, exact: true }).click();
    const player = page.getByRole("contentinfo", { name: "底部播放器" });
    await expect(player.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
    const progress = player.getByRole("slider", { name: "播放进度", exact: true });
    await expect.poll(async () => Number(await progress.inputValue())).toBeGreaterThan(0.2);
    expect(streams.some((stream) => stream.mime.includes(format === "aac" ? "audio/mp4" : "audio/mpeg"))).toBe(true);
    await player.getByRole("button", { name: "暂停", exact: true }).click();
    // 暂停在结尾前一秒，刷新后仍须保留未完成的位置。
    await progress.press("End"); await progress.press("ArrowLeft");
    await expect(progress).toHaveValue("5");
    await expect.poll(async () => (await room.api(page.request, "/api/me")).preferences.position).toBe(5);
    await page.goto(room.url + "/#/home");
    await page.reload();
    await expect(page.getByRole("button", { name: "继续播放", exact: true })).toBeVisible();
    await expect(progress).toHaveValue("5");
    await progress.press("Home"); await progress.press("ArrowRight"); await progress.press("ArrowRight");
    await expect(progress).toHaveValue("2");
    await player.getByRole("button", { name: "播放", exact: true }).click();
    await expect(player.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
    await expect(player.getByRole("button", { name: "播放", exact: true })).toBeVisible({ timeout: 15_000 });
    await page.goto(room.url + "/#/home");
    await expect(page.getByRole("button", { name: "重新播放", exact: true })).toBeVisible();
    await expect.poll(async () => (await room.api(page.request, "/api/me")).preferences.position).toBe(song.duration);
    await info.attach("completion-position.json", {
      body: JSON.stringify({ format, indexedDuration: song.duration, mediaDuration: Number(await progress.getAttribute("max")), savedPosition: (await room.api(page.request, "/api/me")).preferences.position }, null, 2),
      contentType: "application/json",
    });
    await page.reload();
    await expect(page.getByRole("button", { name: "重新播放", exact: true })).toBeVisible();
    const before = streams.length;
    await page.getByRole("button", { name: "重新播放", exact: true }).click();
    await expect.poll(() => streams.length).toBeGreaterThan(before);
    expect(new URL(streams.at(-1)!.url).searchParams.get("start")).toBeNull();
    expect(streams.every((stream) => Number(new URL(stream.url).searchParams.get("start") ?? 0) < song.duration)).toBe(true);
    await expect(player.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
    await player.getByRole("button", { name: "暂停", exact: true }).click();
  });
}

test("真实队列自动下一首，列表循环和单曲循环从零开始", async ({ page, room }) => {
  await room.ready(page);
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  await expect(player).toContainText(titles.alac, { timeout: 15_000 });
  await player.getByRole("button", { name: "顺序播放，点击切换列表循环" }).click();
  await player.getByRole("button", { name: "列表循环，点击切换单曲循环" }).click();
  const alac = await room.track(page.request, titles.alac);
  let loads = 0;
  page.on("request", (request) => { if (request.url().includes(`/api/tracks/${alac.id}/stream`)) loads++; });
  await expect.poll(() => loads, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(player).toContainText(titles.alac);
  await player.getByRole("button", { name: "单曲循环，点击切换顺序播放" }).click();
  await player.getByRole("button", { name: "顺序播放，点击切换列表循环" }).click();
  await page.getByRole("button", { name: `播放 ${titles.mp3}`, exact: true }).click();
  await expect(player).toContainText(titles.aac, { timeout: 15_000 });
  await player.getByRole("button", { name: "暂停", exact: true }).click();
});

test("网络失败能重试，文件丢失提示可跳过而不是清空队列", async ({ page, room }) => {
  await room.ready(page);
  await page.context().setOffline(true);
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("连接中断");
  await page.context().setOffline(false);
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  await expect.poll(async () => Number(await player.getByRole("slider", { name: "播放进度" }).inputValue())).toBeGreaterThan(0.2);
  await player.getByRole("button", { name: "暂停", exact: true }).click();
  const missing = await room.track(page.request, titles.flac);
  fs.renameSync(missing.path, missing.path + ".offline");
  try {
    await page.getByRole("button", { name: `播放 ${titles.flac}`, exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("找不到这首歌的文件");
    await player.getByRole("button", { name: "下一首", exact: true }).click();
    await expect(player).toContainText(titles.mp3);
    await player.getByRole("button", { name: "暂停", exact: true }).click();
  } finally { fs.renameSync(missing.path + ".offline", missing.path); }
});
