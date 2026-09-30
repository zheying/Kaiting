import { devices } from "@playwright/test";
import { test, expect, titles, login } from "./helpers/room.js";
const { defaultBrowserType: phoneBrowser, ...phone } = devices["iPhone 13"];
const { defaultBrowserType: tabletBrowser, ...tablet } = devices["iPad (gen 7)"];

test.describe("手机", () => {
  test.use(phone);
  // Chromium 的设备模拟不改变 macOS navigator.platform；补齐真实手机环境，避免被 iPadOS 探测误识别。
  test.beforeEach(async ({ page }) => { await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "iPhone" })); });
  test("胶囊播放器进入全屏，触摸进度、歌词和待播清单可操作", async ({ page, room }, info) => {
    await room.ready(page);
    await page.locator(".main-content .track-identity").filter({ hasText: titles.aac }).tap();
    const player = page.getByRole("contentinfo", { name: "底部播放器" });
    await player.getByRole("button", { name: "暂停", exact: true }).tap();
    await expect(page.locator(".app")).toHaveClass(/mobile-layout/);
    await expect(player.locator(".mobile-now-playing")).toBeVisible();
    await info.attach("capsule.png", { body: await page.screenshot(), contentType: "image/png" });
    await player.getByRole("button", { name: /^打开沉浸播放器：/ }).tap();
    const full = page.getByRole("dialog", { name: "沉浸播放器" });
    await expect(full.locator(".now-playing-screen")).toHaveClass(/np-mobile/);
    const progress = full.getByRole("slider", { name: "播放进度" });
    const box = await progress.boundingBox();
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect.poll(async () => Number(await progress.inputValue())).toBeGreaterThan(1);
    await full.getByRole("button", { name: "歌词", exact: true }).tap();
    await expect(full.getByRole("region", { name: "歌词", exact: true })).toContainText("第一句测试歌词");
    await full.getByRole("button", { name: "待播清单", exact: true }).tap();
    await expect(full.getByRole("heading", { name: /接下来播放/ })).toBeVisible();
    await full.getByRole("button", { name: `播放 ${titles.flac}`, exact: true }).tap();
    await expect(full.getByRole("heading", { name: titles.flac, exact: true })).toBeVisible();
    await full.getByRole("button", { name: "暂停", exact: true }).tap();
    await full.getByRole("button", { name: "收起播放器", exact: true }).tap();
    await expect(full).toHaveCount(0); await expect(player).toContainText(titles.flac);
  });
});

test("桌面窄屏切换移动布局，恢复宽屏后保留桌面播放器", async ({ page, room }) => {
  await room.ready(page);
  await expect(page.locator(".app")).not.toHaveClass(/mobile-layout/);
  await page.setViewportSize({ width: 479, height: 850 });
  await expect(page.locator(".app")).toHaveClass(/mobile-layout/);
  await page.setViewportSize({ width: 1024, height: 850 });
  await expect(page.locator(".app")).not.toHaveClass(/mobile-layout/);
});

test.describe("iPad", () => {
  test.use({ ...tablet, viewport: { width: 479, height: 900 } });
  test("iPad UA 在窄窗口仍使用平板布局", async ({ page, room }) => {
    await room.ready(page); await expect(page.locator(".app")).not.toHaveClass(/mobile-layout/);
  });
});

test("减少动态效果下登录背景静止，窗口变化和再次登录仍正常", async ({ page, room }, info) => {
  await page.goto(room.url);
  const canvas = page.locator(".login-rhythm-canvas");
  await expect(canvas).toBeVisible();
  const pixels = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await page.getByRole("textbox", { name: "用户名", exact: true }).fill("admin");
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(pixels);
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(canvas).toBeVisible();
  await login(page, room);
  await expect(canvas).toHaveCount(0);
  await page.getByRole("button", { name: "我的账号", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.getByRole("button", { name: "确认退出", exact: true }).click();
  await expect(canvas).toHaveCount(1);
  await info.attach("login-reduced-motion.png", { body: await page.screenshot(), contentType: "image/png" });
});
