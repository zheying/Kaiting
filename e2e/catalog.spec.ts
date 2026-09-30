import { test, expect, titles, ALBUM, ARTIST } from "./helpers/room.js";

test("中文及保留字符搜索、专辑艺人导航、收藏刷新后仍保留", async ({ page, room }) => {
  await room.ready(page);
  const search = page.getByRole("textbox", { name: "搜索歌曲、专辑、艺人" });
  await search.fill("100% / 夜曲"); await search.press("Enter");
  await expect(page.locator(".search-albums")).toContainText(ALBUM);
  await page.locator(".search-albums .album-name").click();
  await expect(page.getByRole("heading", { name: ALBUM, exact: true })).toBeVisible();
  await page.getByRole("button", { name: ARTIST, exact: true }).click();
  await expect(page.getByRole("heading", { name: ARTIST, exact: true })).toBeVisible();
  await page.getByRole("button", { name: `收藏 ${titles.aac}`, exact: true }).click();
  await page.goto(room.url + "/#/favorites"); await page.reload();
  await expect(page.locator(".main-content .track-identity strong")).toHaveText([titles.aac]);
});

test("专辑请求失败可单独重试，歌曲保持可用，晚到响应不改写新的搜索", async ({ page, room }) => {
  await room.loginApi(page.request); await room.scan(page.request);
  let blocked = true;
  await page.route("**/api/albums?**", (route) => blocked ? route.fulfill({ status: 503, json: { error: "测试：专辑暂时离线" } }) : route.continue());
  await page.goto(room.url + "/#/songs");
  await expect(page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true })).toBeVisible();
  await page.goto(room.url + "/#/albums");
  await expect(page.getByRole("button", { name: "重新载入专辑", exact: true })).toBeVisible();
  blocked = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/albums?**", async (route) => { const response = await route.fetch(); await pending; await route.fulfill({ response }); });
  await page.getByRole("button", { name: "重新载入专辑", exact: true }).click();
  const search = page.getByRole("textbox", { name: "搜索歌曲、专辑、艺人" });
  await search.fill(titles.flac); await search.press("Enter");
  release();
  await expect(page.locator(".main-content .track-identity strong")).toHaveText([titles.flac]);
  await expect(search).toHaveValue(titles.flac);
  await page.goto(room.url + "/#/albums");
  await expect(page.locator(".album-name")).toContainText(ALBUM);
});

test.describe("跨 API 分页", () => {
  test.use({ roomOptions: { extraTracks: 501 } });
  test("超过一页的真实曲库能组成完整播放队列", async ({ page, room }) => {
    await room.ready(page);
    await expect(page.locator(".page-heading")).toContainText("505");
    await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
    const player = page.getByRole("contentinfo", { name: "底部播放器" });
    await player.getByRole("button", { name: "暂停", exact: true }).click();
    await player.getByRole("button", { name: "打开待播清单", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "待播清单" }).locator(".queue-row")).toHaveCount(505);
    await expect.poll(async () => (await room.api(page.request, "/api/me")).preferences.queue.length).toBe(505);
  });
});
