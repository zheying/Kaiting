import { test, expect, ALBUM, titles, type RoomFixture } from "./helpers/room.js";
import type { Page } from "@playwright/test";
import type { Album, AlbumMetadata } from "../src/shared/types.js";

test.use({ roomOptions: { metadata: true } });
const endpoint = (album: Album) => `/api/admin/albums/${encodeURIComponent(album.key)}/metadata`;
const card = (page: Page, title: string) => page.locator(".album-card").filter({ has: page.getByText(title, { exact: true }) });
async function waitForCompletion(page: Page, room: RoomFixture) {
  await expect.poll(async () => (await room.api(page.request, "/api/catalog/status")).enrichment.state, { timeout: 30_000 }).toBe("completed");
}
async function edit(page: Page, title: string) {
  await card(page, title).getByRole("button", { name: `打开专辑 ${title}`, exact: true }).click();
  await page.getByRole("button", { name: "编辑专辑信息", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "编辑专辑信息", exact: true })).toBeVisible();
  await expect(page.getByLabel("发行年份", { exact: true })).toBeEditable();
  await expect(page.getByRole("button", { name: /自动补全|重新查找/ })).toHaveCount(0);
}
async function rescan(page: Page, room: RoomFixture) {
  await room.api(page.request, "/api/scan", "POST", {});
  await expect.poll(async () => await room.api(page.request, "/api/scan")).toMatchObject({ status: "completed", errorCount: 0 });
}

test("默认在后台完成扫描补全，无需打开页面；人工修正和恢复在重扫后保留", async ({ page, room }, info) => {
  await room.loginApi(page.request); await room.scan(page.request);
  await waitForCompletion(page, room);
  const [album]: Album[] = await room.api(page.request, "/api/albums");
  expect(album).toMatchObject({ year: 2018, genre: "爵士" });
  const metadata: AlbumMetadata = await room.api(page.request, endpoint(album));
  expect(metadata).toMatchObject({ autoCompleteEnabled: true, automatic: { year: 2018, genre: "爵士" }, original: { year: null, genre: null } });
  expect(room.upstream.requests.length).toBeGreaterThan(0);

  await page.goto(`${room.url}/#/albums`); await edit(page, ALBUM);
  await expect(page.getByLabel("发行年份", { exact: true })).toHaveValue("2018");
  await expect(page.getByRole("link", { name: "查看自动补全的 MusicBrainz 来源" })).toHaveAttribute("href", /^https:\/\/musicbrainz.org\/release\//);
  await info.attach("automatic-source-desktop.png", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByLabel("发行年份", { exact: true }).fill("2020");
  await page.getByLabel("音乐流派", { exact: true }).fill("个人精选");
  await page.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await rescan(page, room); await waitForCompletion(page, room); await page.reload();
  await page.getByRole("button", { name: "回到唱片架", exact: true }).click();
  await expect(card(page, ALBUM).locator(".album-metadata-line")).toContainText("2020 · 个人精选");
  await edit(page, ALBUM);
  await expect(page.getByText("已保留人工设置，后台不会自动修改。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "恢复扫描信息", exact: true }).click();
  await page.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const queries = room.upstream.requests.length;
  await rescan(page, room); await waitForCompletion(page, room);
  expect(await room.api(page.request, endpoint(album))).toMatchObject({ autoFillBlocked: true, automatic: null, album: { year: null, genre: null } });
  expect(room.upstream.requests).toHaveLength(queries);
  await page.setViewportSize({ width: 393, height: 852 }); await page.reload();
  await page.getByRole("button", { name: "回到唱片架", exact: true }).click(); await edit(page, ALBUM);
  const bounds = await page.getByRole("dialog").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(393);
  expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(852);
  await expect(page.getByRole("button", { name: "保存信息", exact: true })).toBeInViewport();
  await info.attach("manual-edit-mobile.png", { body: await page.screenshot(), contentType: "image/png" });
});

test("新增专辑后的扫描自动补全，已打开的唱片架自动更新", async ({ page, room }) => {
  room.upstream.delay = 700;
  await room.ready(page, "albums");
  await expect(card(page, ALBUM).locator(".album-metadata-line")).toContainText("2018 · 爵士", { timeout: 30_000 });
  const queries = room.upstream.requests.length;
  room.addAlbum("新加入的专辑");
  await rescan(page, room);
  expect(await room.api(page.request, "/api/scan")).toMatchObject({ parsedFiles: 4, skippedFiles: 4 });
  await expect(card(page, "新加入的专辑").locator(".album-metadata-line")).toContainText("2018 · 爵士", { timeout: 30_000 });
  expect(room.upstream.requests.length).toBeGreaterThan(queries);
  const albums: Album[] = await room.api(page.request, "/api/albums");
  expect(albums).toHaveLength(2);
  expect(await room.api(page.request, endpoint(albums.find((album) => album.title === "新加入的专辑")!))).toMatchObject({ automatic: { year: 2018, genre: "爵士" } });
});

test("后台查询晚到不会覆盖人工修正，扫描不等待在线服务", async ({ page, room }) => {
  room.upstream.delay = 3_000;
  await room.ready(page, "albums");
  expect(await room.api(page.request, "/api/scan")).toMatchObject({ status: "completed" });
  expect((await room.api(page.request, "/api/catalog/status")).enrichment.state).toBe("running");
  await expect.poll(() => room.upstream.requests.length).toBeGreaterThan(0);
  await edit(page, ALBUM);
  await page.getByLabel("发行年份", { exact: true }).fill("2025");
  await page.getByLabel("音乐流派", { exact: true }).fill("我的修正");
  await page.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await waitForCompletion(page, room);
  const [album]: Album[] = await room.api(page.request, "/api/albums");
  expect(await room.api(page.request, endpoint(album))).toMatchObject({ autoFillBlocked: true, automatic: null, album: { year: 2025, genre: "我的修正" } });
});

for (const mode of ["ambiguous", "error"] as const) {
  test(`上游${mode === "ambiguous" ? "年份有歧义时只补共同流派" : "连接失败时保留空白"}，本地扫描和人工编辑可用`, async ({ page, room }) => {
    room.upstream.mode = mode;
    await room.ready(page, "albums");
    await expect.poll(async () => (await room.api(page.request, "/api/catalog/status")).enrichment.state, { timeout: 30_000 }).toBe(mode === "error" ? "waiting" : "completed");
    const [album]: Album[] = await room.api(page.request, "/api/albums");
    expect(album).toMatchObject({ year: null, genre: mode === "ambiguous" ? "爵士" : null });
    expect(await room.api(page.request, endpoint(album))).toMatchObject({ automatic: mode === "ambiguous" ? { year: null, genre: "爵士" } : null });
    await edit(page, ALBUM);
    await page.getByLabel("发行年份", { exact: true }).fill("2022");
    await page.getByRole("button", { name: "保存信息", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await room.api(page.request, endpoint(album))).toMatchObject({ autoFillBlocked: true, album: { year: 2022 } });
  });
}

test("多个发行版本字段一致时无人干预保存，并保留全部来源", async ({ page, room }, info) => {
  room.upstream.variants = Array.from({ length: 8 }, () => ({}));
  await room.loginApi(page.request); await room.scan(page.request); await waitForCompletion(page, room);
  const [album]: Album[] = await room.api(page.request, "/api/albums");
  expect(album).toMatchObject({ year: 2018, genre: "爵士" });
  const metadata = await room.api(page.request, endpoint(album));
  expect(metadata.automatic.sources.year).toHaveLength(8);
  expect(metadata.automatic.sources.genre).toHaveLength(8);
  await info.attach("consensus-sources.json", { body: JSON.stringify(metadata), contentType: "application/json" });
  await page.goto(`${room.url}/#/albums`);
  await expect(card(page, ALBUM).locator(".album-metadata-line")).toContainText("2018 · 爵士");
  await edit(page, ALBUM);
  await expect(page.getByLabel("发行年份", { exact: true })).toHaveValue("2018");
});

test.describe("合辑署名和不同分碟", () => {
  test.use({ roomOptions: { metadata: true, artist: "Various Artists", discs: 2 } });
  test("核对完整曲目与时长后自动保存，服务重启保留字段来源", async ({ page, room }) => {
    room.upstream.variants = [{ "artist-credit": [{ name: "Various Artists" }] }];
    await room.ready(page, "albums"); await waitForCompletion(page, room);
    const [album]: Album[] = await room.api(page.request, "/api/albums");
    expect(album).toMatchObject({ discCount: 2, year: 2018, genre: "爵士" });
    const before = await room.api(page.request, endpoint(album));
    await room.stop(); await room.start(); await room.loginApi(page.request);
    expect((await room.api(page.request, endpoint(album))).automatic).toEqual(before.automatic);
    await page.goto(`${room.url}/#/albums`);
    await expect(card(page, ALBUM).locator(".album-metadata-line")).toContainText("2018 · 爵士");
  });
  test("同名同曲目数但曲目内容不一致时保持空白", async ({ page, room }) => {
    room.upstream.variants = [{ "artist-credit": [{ name: "Various Artists" }], media: [{ "track-count": 4, tracks: ["别的歌曲", "ALAC 夜色", "FLAC 雨声", "MP3 星河"].map((title) => ({ title, length: 6000 })) }] }];
    await room.ready(page, "albums"); await waitForCompletion(page, room);
    const [album]: Album[] = await room.api(page.request, "/api/albums");
    expect(album).toMatchObject({ year: null, genre: null });
    expect((await room.api(page.request, endpoint(album))).automatic).toBeNull();
    await expect(card(page, ALBUM).locator(".album-metadata-line")).toContainText("年份未知 · 未分类");
  });
  test("使用在线发行关联的原文曲名验证本地曲目，无需人工选择语言版本", async ({ page, room }) => {
    room.upstream.variants = [{ "artist-credit": [{ name: "Various Artists" }], media: [{ "track-count": 4, tracks: Object.values(titles).map((title, i) => ({ title: `Translated title ${i}`, recording: { title, length: 6000 } })) }] }];
    await room.ready(page, "albums"); await waitForCompletion(page, room);
    await expect(card(page, ALBUM).locator(".album-metadata-line")).toContainText("2018 · 爵士");
  });
});

test.describe("关闭后台查询", () => {
  test.use({ roomOptions: { metadata: true, autoEnrich: false } });
  test("在线参考不阻塞人工编辑，版本冲突保留草稿直到明确重新载入", async ({ page, room }) => {
    await room.ready(page, "albums"); await edit(page, ALBUM);
    const [album]: Album[] = await room.api(page.request, "/api/albums");
    const metadata = await room.api(page.request, endpoint(album));
    expect(metadata.autoCompleteEnabled).toBe(false);
    await page.getByLabel("发行年份", { exact: true }).fill("2019");
    await page.getByLabel("音乐流派", { exact: true }).fill("当前草稿");
    await room.api(page.request, endpoint(album), "PUT", { revision: metadata.revision, year: 2021, genre: "另一个设备" });
    await page.getByRole("button", { name: "保存信息", exact: true }).click();
    await expect(page.getByRole("button", { name: "载入最新信息", exact: true })).toBeVisible();
    await expect(page.getByLabel("发行年份", { exact: true })).toHaveValue("2019");
    await expect(page.getByLabel("音乐流派", { exact: true })).toHaveValue("当前草稿");
    await page.getByRole("button", { name: "载入最新信息", exact: true }).click();
    await expect(page.getByLabel("发行年份", { exact: true })).toHaveValue("2021");
    await expect(page.getByLabel("音乐流派", { exact: true })).toHaveValue("另一个设备");
    await expect.poll(() => room.upstream.requests.length).toBeGreaterThan(0);
  });
});
