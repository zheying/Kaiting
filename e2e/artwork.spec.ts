import sharp from "sharp";
import { devices, type Locator } from "@playwright/test";
import { test, expect, titles, addSong } from "./helpers/room.js";

for (const mobile of [false, true]) {
  test.describe(mobile ? "手机 3x" : "桌面 2x", () => {
    test.use({ roomOptions: { artwork: true }, viewport: mobile ? { width: 393, height: 852 } : { width: 1440, height: 1000 },
      deviceScaleFactor: mobile ? 3 : 2, isMobile: mobile, hasTouch: mobile,
      ...(mobile ? { userAgent: devices["Pixel 7"].userAgent } : {}) });
    if (mobile) test.beforeEach(async ({ page }) => {
      // Chromium on macOS keeps MacIntel even under touch emulation, which
      // would correctly select the product's iPadOS branch. Model Android here.
      await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "Linux armv8l" }));
    });

    test("大封面按显示尺寸加载，小播放器、队列和背景不请求原图", async ({ page, room }, info) => {
      const requests: string[] = [];
      page.on("request", (request) => { if (request.url().includes("/artwork")) requests.push(request.url().replace(room.url, "")); });
      const checked: object[] = [];
      async function checkImage(locator: Locator, label: string, maxSize = 1600) {
        await expect(locator).toBeVisible();
        await expect.poll(() => locator.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
        const display = await locator.evaluate((node: HTMLImageElement) => ({ src: node.currentSrc, width: node.clientWidth, height: node.clientHeight, dpr: devicePixelRatio }));
        const size = Number(new URL(display.src).searchParams.get("size"));
        expect(size, label).toBeGreaterThanOrEqual(Math.min(1600, Math.ceil(Math.max(display.width, display.height) * display.dpr)));
        expect(size, label).toBeLessThanOrEqual(maxSize);
        const response = await page.request.get(display.src);
        const bytes = await response.body();
        const image = await sharp(bytes).metadata();
        expect(response.headers()["content-type"]).toBe("image/webp");
        expect(image.width).toBe(size); expect(image.height).toBe(size);
        checked.push({ label, ...display, src: display.src.replace(room.url, ""), size, bytes: bytes.length });
        return bytes.length;
      }
      await room.ready(page);
      await expect(page.locator(".app")).toHaveClass(mobile ? /mobile-layout/ : /desktop-layout/);
      await checkImage(page.locator(".track-identity img").first(), "歌曲行", 256);
      if (mobile) await page.locator(".main-content .track-identity").filter({ hasText: titles.aac }).tap();
      else await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
      const player = page.getByRole("contentinfo", { name: "底部播放器" });
      await player.getByRole("button", { name: "暂停", exact: true }).click();
      const smallBytes = await checkImage(player.locator("img"), "底部播放器", 128);
      const song = await room.track(page.request, titles.aac);
      const original = await page.request.get(`${room.url}/api/tracks/${song.id}/artwork`);
      expect((await sharp(await original.body()).metadata()).width).toBe(3000);
      expect(smallBytes).toBeLessThan((await original.body()).length / 20);
      const systemCovers = await page.evaluate(() => navigator.mediaSession.metadata?.artwork ?? []);
      expect(systemCovers.length).toBeGreaterThan(0);
      expect(systemCovers.every((cover) => Number(new URL(cover.src).searchParams.get("size")) <= 512 && Number(new URL(cover.src).searchParams.get("size")) > 0)).toBe(true);
      await page.goto(`${room.url}/#/albums`);
      await checkImage(page.locator(".album-card .cover").first(), "专辑卡片");
      await info.attach("albums.png", { body: await page.screenshot(), contentType: "image/png" });
      await page.goto(`${room.url}/#/playing`);
      await checkImage(page.locator(".np-artwork > img"), "全屏封面");
      for (const source of await page.locator(".np-atmosphere > img").evaluateAll((images) => images.map((node) => (node as HTMLImageElement).src))) {
        expect(Number(new URL(source).searchParams.get("size"))).toBe(128);
      }
      await page.getByRole("button", { name: "待播清单", exact: true }).click();
      await checkImage(page.locator(".np-queue-select > img").first(), "待播封面", 256);
      await info.attach("playing.png", { body: await page.screenshot(), contentType: "image/png" });
      await page.getByRole("button", { name: "收起播放器", exact: true }).click();
      await page.goto(`${room.url}/#/playlists`);
      await page.locator(".main-content").getByRole("button", { name: "新建歌单", exact: true }).first().click();
      await page.getByRole("dialog").getByLabel("歌单名称").fill("按尺寸加载");
      await page.getByRole("dialog").getByRole("button", { name: "创建歌单", exact: true }).click();
      await expect(page.getByRole("heading", { name: "按尺寸加载", exact: true })).toBeVisible();
      await addSong(page, titles.aac);
      await checkImage(page.locator(".playlist-detail-art img"), "歌单封面");
      if (!mobile) await checkImage(page.locator(".sidebar-playlist-art img"), "侧栏小封面", 64);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((url) => new URL(url, room.url).searchParams.has("size")), "页面及锁屏封面没有原图请求").toBe(true);
      await info.attach("artwork-sizes.json", { body: JSON.stringify({ originalBytes: (await original.body()).length, checked, requests, systemCovers }, null, 2), contentType: "application/json" });

      // 外部网络失败应显示占位，不能绕过缩略图回退下载原图。
      await page.route("**/artwork?*", (route) => route.fulfill({ status: 422, contentType: "application/json", body: '{"error":"封面无法读取"}' }));
      await page.goto(`${room.url}/#/albums`); await page.reload();
      await expect(page.locator(".album-card .artwork-fallback").first()).toBeVisible();
      expect(requests.every((url) => new URL(url, room.url).searchParams.has("size"))).toBe(true);
    });
  });
}
