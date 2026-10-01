import { test, expect, titles } from "./helpers/room.js";
import { observeAtmosphere, soundSnapshot } from "./helpers/atmosphere-observation.js";

test.use({ roomOptions: { mediaConnection: true, artwork: true, audioDuration: 20, rhythmic: true } });

test("NAS 直连真实音频和封面，普通操作仍走页面入口", async ({ page, room }, info) => {
  await observeAtmosphere(page);
  await room.ready(page);
  await page.getByRole("button", { name: "音乐室设置", exact: true }).click();
  await expect(page.getByTestId("media-connection-status")).toContainText("NAS 直连");
  await info.attach("direct-settings.png", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  const streams: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/stream")) streams.push(request.url()); });
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  await expect.poll(async () => Number(await player.getByRole("slider", { name: "播放进度", exact: true }).inputValue())).toBeGreaterThan(0.3);
  await expect.poll(async () => (await soundSnapshot(page)).rms).toBeGreaterThan(0.01);
  await info.attach("direct-audio.json", { body: JSON.stringify(await soundSnapshot(page)), contentType: "application/json" });
  expect(streams.some((url) => url.startsWith(room.directMediaOrigin))).toBe(true);
  expect(streams.every((url) => !new URL(url).searchParams.has("token"))).toBe(true);
  expect(room.directMediaRequests.some((r) => r.url.includes("/artwork?size="))).toBe(true);
  expect(room.directMediaRequests.every((r) => !r.url.includes("/playlists") && !r.url.includes("/preferences"))).toBe(true);
  await info.attach("direct-media-requests.json", { body: JSON.stringify(room.directMediaRequests, null, 2), contentType: "application/json" });
  await player.getByRole("button", { name: "暂停", exact: true }).click();
});

test("直连授权不可达时正常公网播放，手动重试可恢复直连", async ({ page, room }) => {
  await page.route("**/api/media/probe", (route) => route.abort("accessdenied"));
  await room.ready(page);
  await page.getByRole("button", { name: "音乐室设置", exact: true }).click();
  await expect(page.getByTestId("media-connection-status")).toContainText("公网中转");
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  const streams: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/stream")) streams.push(request.url()); });
  await page.getByRole("button", { name: `播放 ${titles.flac}`, exact: true }).click();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  await expect.poll(async () => Number(await player.getByRole("slider", { name: "播放进度", exact: true }).inputValue())).toBeGreaterThan(0.3);
  expect(streams.every((url) => url.startsWith(room.url))).toBe(true);
  await page.unroute("**/api/media/probe");
  await page.getByRole("button", { name: "音乐室设置", exact: true }).click();
  await page.getByRole("button", { name: "重新检测直连" }).click();
  await expect(page.getByTestId("media-connection-status")).toContainText("NAS 直连");
  // 检测完成不能重载正在播放的歌曲。
  expect(streams.every((url) => url.startsWith(room.url))).toBe(true);
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await player.getByRole("button", { name: "暂停", exact: true }).click();
});

test("直连转码 seek 失败回退公网并保留进度，手动仅公网可持续生效", async ({ page, room }, info) => {
  await room.ready(page);
  await page.getByRole("button", { name: "音乐室设置", exact: true }).click();
  await expect(page.getByTestId("media-connection-status")).toContainText("NAS 直连");
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  const streams: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/stream")) streams.push(request.url()); });
  await page.getByRole("button", { name: `播放 ${titles.alac}`, exact: true }).click();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  const progress = player.getByRole("slider", { name: "播放进度", exact: true });
  await expect.poll(async () => Number(await progress.inputValue())).toBeGreaterThan(0.3);
  // 外部 HTTP 边界故障；不修改播放器状态或伪造媒体事件。
  room.directMediaBlocked = true;
  // 一次提交 seek；播放中的首个 seek 会暂时禁用滑块，不能用连按冒充拖动。
  const bounds = (await progress.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * 0.2, bounds.y + bounds.height / 2);
  await expect.poll(() => streams.some((url) => url.startsWith(room.url) && Number(new URL(url).searchParams.get("start")) >= 2)).toBe(true);
  await expect.poll(async () => Number(await progress.inputValue())).toBeGreaterThan(3.1);
  await info.attach("fallback-streams.json", { body: JSON.stringify(streams, null, 2), contentType: "application/json" });
  await player.getByRole("button", { name: "暂停", exact: true }).click();
  await page.getByRole("button", { name: "音乐室设置", exact: true }).click();
  await page.getByRole("switch", { name: "优先 NAS 直连" }).click();
  await expect(page.getByTestId("media-connection-status")).toContainText("仅使用公网");
  room.directMediaBlocked = false;
  await page.reload();
  await page.getByRole("button", { name: "音乐室设置", exact: true }).click();
  await expect(page.getByTestId("media-connection-status")).toContainText("仅使用公网");
});

test("直连请求一直不响应时有界回退，原格式音频继续播放", async ({ page, room }, info) => {
  await room.ready(page);
  await page.getByRole("button", { name: "音乐室设置", exact: true }).click();
  await expect(page.getByTestId("media-connection-status")).toContainText("NAS 直连");
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  room.directMediaStalled = true;
  const streams: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/stream")) streams.push(request.url()); });
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  await expect.poll(async () => Number(await player.getByRole("slider", { name: "播放进度", exact: true }).inputValue())).toBeGreaterThan(0.3);
  expect(streams.some((url) => url.startsWith(room.directMediaOrigin))).toBe(true);
  expect(streams.filter((url) => url.startsWith(room.url))).toHaveLength(1);
  await player.getByRole("button", { name: "暂停", exact: true }).click();
  await info.attach("stalled-fallback.json", { body: JSON.stringify(streams), contentType: "application/json" });
});
