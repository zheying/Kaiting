import fs from "node:fs";
import { test, expect, login, selectDirectory, titles, createPlaylist, addSong } from "./helpers/room.js";

test("选择真实目录完成扫描，增量重扫跳过未修改音频", async ({ page, room }) => {
  await login(page, room);
  await expect(page.getByRole("heading", { name: "先把音乐带进来" })).toBeVisible();
  await selectDirectory(page, room);
  await expect(page.getByRole("heading", { name: "曲库已经准备好" })).toBeVisible();
  const first = await room.api(page.request, "/api/scan");
  expect(first).toMatchObject({ status: "completed", parsedFiles: 4, skippedFiles: 0, errorCount: 0 });
  await page.getByRole("button", { name: "音乐室设置", exact: true }).click();
  await page.getByRole("button", { name: "重新扫描", exact: true }).click();
  await expect.poll(async () => await room.api(page.request, "/api/scan")).toMatchObject({ status: "completed", parsedFiles: 0, skippedFiles: 4 });
  await page.goto(room.url + "/#/songs");
  await expect(page.locator(".main-content .track-row")).toHaveCount(4);
});

test.describe("异常音频", () => {
  test.use({ roomOptions: { badAudio: true } });
  test("部分失败有详情，成功曲目仍能浏览", async ({ page, room }) => {
    await login(page, room); await selectDirectory(page, room);
    await expect(page.getByRole("heading", { name: "这次扫描没有完全成功" })).toBeVisible();
    await page.getByRole("button", { name: /查看失败|失败详情/ }).click();
    await expect(page.getByRole("dialog")).toContainText("broken.flac");
    expect(await room.api(page.request, "/api/scan")).toMatchObject({ status: "completed", errorCount: 1, parsedFiles: 4 });
    await page.goto(room.url + "/#/songs");
    await expect(page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true })).toBeVisible();
  });
});

test("目录离线和失败清理不会清空收藏歌单，恢复后可继续扫描", async ({ page, room }) => {
  await room.ready(page);
  const song = await room.track(page.request, titles.aac);
  await page.getByRole("button", { name: `收藏 ${titles.aac}`, exact: true }).click();
  await createPlaylist(page, "离线保留"); await addSong(page, titles.aac);
  fs.renameSync(room.music, room.music + "-offline");
  try {
    await page.goto(room.url + "/#/directory-unavailable");
    await expect(page.getByRole("heading", { name: "音乐目录暂时不可访问" })).toBeVisible();
    await page.getByRole("button", { name: "重新检查", exact: true }).click();
    await expect(page.getByRole("region", { name: "音乐目录不可访问" })).toContainText("已保存的收藏和歌单不会受影响");
    await room.api(page.request, "/api/scan", "POST", { prune: true });
    await expect.poll(async () => (await room.api(page.request, "/api/scan"))?.status).toBe("failed");
    expect((await room.api(page.request, "/api/tracks?favorite=true")).map((track: { id: string }) => track.id)).toContain(song.id);
    expect((await room.api(page.request, "/api/playlists"))[0]).toMatchObject({ name: "离线保留", trackCount: 1 });
  } finally { fs.renameSync(room.music + "-offline", room.music); }
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(page.getByRole("heading", { name: "曲库已经准备好" })).toBeVisible();
});

test.describe("运行中停止", () => {
  test.use({ roomOptions: { extraTracks: 2000 } });
  test("真实扫描可从页面中断并继续，已保存数据不丢失", async ({ page, room }) => {
    await login(page, room); await selectDirectory(page, room);
    await page.getByRole("button", { name: "停止扫描", exact: true }).click();
    await expect.poll(async () => (await room.api(page.request, "/api/scan"))?.status).toBe("interrupted");
    const first = await room.api(page.request, "/api/scan");
    expect(first.prune).toBe(false);
    await page.getByRole("button", { name: "重新扫描", exact: true }).click();
    await expect.poll(async () => (await room.api(page.request, "/api/scan"))?.status, { timeout: 60_000 }).toBe("completed");
    expect((await room.api(page.request, "/api/summary")).trackCount).toBe(2004);
  });
});
