import { test, expect, ALBUM, type RoomFixture } from "./helpers/room.js";
import type { Page } from "@playwright/test";
import type { Album } from "../src/shared/types.js";

test.use({ roomOptions: { metadata: true, autoEnrich: false } });
const endpoint = (album: Album) => `/api/admin/albums/${encodeURIComponent(album.key)}/metadata`;
async function open(page: Page, room: RoomFixture) {
  await room.ready(page, "albums");
  await page.getByRole("button", { name: `打开专辑 ${ALBUM}`, exact: true }).click();
  await page.getByRole("button", { name: "编辑专辑信息", exact: true }).click();
  await expect(page.getByLabel("发行年份", { exact: true })).toBeEditable();
  return page.getByRole("region", { name: "发行参考", exact: true });
}

test("展示不一致的发行参考，选用只改草稿，取消不保存，确认后才持久化", async ({ page, room }, info) => {
  room.upstream.variants = [{ date: "2020-04-10", "track-count": 3, media: [{ "track-count": 3, format: "CD" }], genres: [{ name: "soundtrack", count: 2 }] }];
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/metadata")) writes.push(request.url()); });
  const references = await open(page, room);
  await expect(references.getByText("2020-04-10", { exact: false })).toBeVisible();
  await expect(references.getByText("曲目数不同：候选 3 首 / 本地 4 首", { exact: true })).toBeVisible();
  await expect(references.getByRole("link", { name: "查看 MusicBrainz 发行来源" })).toHaveAttribute("href", /^https:\/\/musicbrainz.org\/release\//);
  await expect(page.getByLabel("发行年份", { exact: true })).toHaveValue("");
  await references.getByRole("button", { name: "采用此版本", exact: true }).click();
  await expect(page.getByLabel("发行年份", { exact: true })).toHaveValue("2020");
  await expect(page.getByLabel("音乐流派", { exact: true })).toHaveValue("原声");
  expect(writes).toHaveLength(0);
  await info.attach("candidate-desktop.png", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  const [album]: Album[] = await room.api(page.request, "/api/albums");
  expect(album).toMatchObject({ year: null, genre: null });
  await page.setViewportSize({ width: 393, height: 852 });
  await page.getByRole("button", { name: "编辑专辑信息", exact: true }).click();
  await expect(page.getByLabel("发行年份", { exact: true })).toHaveValue("");
  await references.getByRole("button", { name: "采用此版本", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑专辑信息", exact: true });
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(393);
  expect(bounds!.height).toBeLessThanOrEqual(828);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "保存信息", exact: true })).toBeInViewport();
  await info.attach("candidate-mobile.png", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await room.api(page.request, endpoint(album))).toMatchObject({ autoFillBlocked: true, album: { year: 2020, genre: "原声" } });
  expect(writes).toHaveLength(1);
});

test("迟到的参考不覆盖输入，候选缺少的字段保留草稿", async ({ page, room }) => {
  room.upstream.delay = 700;
  room.upstream.variants = [{ genres: [] }];
  const references = await open(page, room);
  await page.getByLabel("发行年份", { exact: true }).fill("2024");
  await page.getByLabel("音乐流派", { exact: true }).fill("我的分类");
  await expect(references.getByRole("button", { name: "采用此版本", exact: true })).toBeVisible();
  await expect(page.getByLabel("发行年份", { exact: true })).toHaveValue("2024");
  await expect(page.getByLabel("音乐流派", { exact: true })).toHaveValue("我的分类");
  await references.getByRole("button", { name: "采用此版本", exact: true }).click();
  await expect(page.getByLabel("发行年份", { exact: true })).toHaveValue("2018");
  await expect(page.getByLabel("音乐流派", { exact: true })).toHaveValue("我的分类");
});

test("查询失败可以重试，同时允许人工输入和保存", async ({ page, room }) => {
  room.upstream.mode = "error";
  const references = await open(page, room);
  await expect(references.getByRole("button", { name: "重试查询", exact: true })).toBeVisible();
  await page.getByLabel("发行年份", { exact: true }).fill("2022");
  await expect(page.getByRole("button", { name: "保存信息", exact: true })).toBeEnabled();
  room.upstream.mode = "unique";
  await references.getByRole("button", { name: "重试查询", exact: true }).click();
  await expect(references.getByRole("button", { name: "采用此版本", exact: true })).toBeVisible();
  await expect(page.getByLabel("发行年份", { exact: true })).toHaveValue("2022");
  await page.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await room.api(page.request, "/api/albums"))[0].year).toBe(2022);
});

test("没有参考时明确提示，手动保存仍可用", async ({ page, room }) => {
  room.upstream.variants = [];
  const references = await open(page, room);
  await expect(references.getByText("暂未找到对应的发行信息，可直接在下方填写。", { exact: true })).toBeVisible();
  await page.getByLabel("发行年份", { exact: true }).fill("2021");
  await page.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("查询版本冲突保留草稿，明确重新载入才替换", async ({ page, room }) => {
  room.upstream.delay = 800;
  const references = await open(page, room);
  await expect.poll(() => room.upstream.requests.length).toBeGreaterThan(0);
  const [album]: Album[] = await room.api(page.request, "/api/albums");
  const metadata = await room.api(page.request, endpoint(album));
  await page.getByLabel("发行年份", { exact: true }).fill("2019");
  await room.api(page.request, endpoint(album), "PUT", { revision: metadata.revision, year: 2022, genre: "另一台设备" });
  await expect(page.getByRole("button", { name: "载入最新信息", exact: true })).toBeVisible();
  await expect(page.getByLabel("发行年份", { exact: true })).toHaveValue("2019");
  await expect(page.getByRole("button", { name: "保存信息", exact: true })).toBeDisabled();
  await expect(references.getByRole("button", { name: "采用此版本", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "载入最新信息", exact: true }).click();
  await expect(page.getByLabel("发行年份", { exact: true })).toHaveValue("2022");
});

test("较多且截断的参考可展开浏览，并标出不完整状态", async ({ page, room }, info) => {
  room.upstream.variants = Array.from({ length: 13 }, (_, index) => ({ date: `${2000 + index}-01-01` }));
  const references = await open(page, room);
  await expect(references.getByText("仅展示部分发行版本，请核对来源后选用。", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(references.getByRole("button", { name: "采用此版本", exact: true })).toHaveCount(2);
  await references.getByRole("button", { name: "展开其余 10 个版本", exact: true }).click();
  await expect(references.getByRole("button", { name: "采用此版本", exact: true })).toHaveCount(12);
  await references.getByRole("button", { name: "采用此版本", exact: true }).last().click();
  await expect(page.getByLabel("发行年份", { exact: true })).toHaveValue("2011");
  await info.attach("expanded-releases.png", { body: await page.screenshot(), contentType: "image/png" });
});

test.describe("关闭在线能力", () => {
  test.use({ roomOptions: { metadata: false, autoEnrich: false } });
  test("不查询上游，保留人工编辑", async ({ page, room }) => {
    const references = await open(page, room);
    await expect(references.getByText("在线查询未开启，可直接在下方填写。", { exact: true })).toBeVisible();
    await expect(references.getByRole("button")).toHaveCount(0);
    await page.getByLabel("发行年份", { exact: true }).fill("2020");
    await page.getByRole("button", { name: "保存信息", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(room.upstream.requests).toHaveLength(0);
  });
});
