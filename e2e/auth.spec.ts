import { test, expect, login, ADMIN_PASSWORD, PERSONAL_PASSWORD } from "./helpers/room.js";

test("错误凭据不进入音乐室，登录后可退出并返回登录页", async ({ page, room }) => {
  await login(page, room, "admin", "wrong-password");
  await expect(page.getByRole("alert")).toContainText("密码");
  await page.getByLabel(/^登录密码/).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".app")).toBeVisible();
  await page.getByRole("button", { name: "我的账号", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.getByRole("button", { name: "确认退出", exact: true }).click();
  await expect(page.getByRole("heading", { name: "欢迎回到开听" })).toBeVisible();
  expect((await page.request.get(room.url + "/api/me")).status()).toBe(401);
});

test("临时密码首用改密，普通成员受限，会话撤销后重新登录回到原页面", async ({ page, room, playwright }) => {
  const admin = await playwright.request.newContext();
  try {
    await room.loginApi(admin); await room.scan(admin);
    const created = await room.api(admin, "/api/admin/users", "POST", { username: "listener", displayName: "测试听众", role: "member" });
    await login(page, room, "listener", created.temporaryPassword, "favorites");
    await expect(page.getByRole("heading", { name: "让账号，只属于你" })).toBeVisible();
    expect((await page.request.get(room.url + "/api/tracks")).status()).toBe(403);
    await page.getByLabel(/^新密码/).fill(PERSONAL_PASSWORD);
    await page.getByLabel(/^确认新密码/).fill(PERSONAL_PASSWORD);
    await page.getByRole("button", { name: "保存并进入音乐室" }).click();
    await expect(page).toHaveURL(/#\/favorites$/);
    await expect(page.getByRole("heading", { name: "一听，就很喜欢" })).toBeVisible();
    await page.goto(room.url + "/#/admin/users");
    await expect(page.getByRole("heading", { name: /权限|管理员/ }).first()).toBeVisible();
    expect((await page.request.get(room.url + "/api/admin/users")).status()).toBe(403);
    await page.goto(room.url + "/#/favorites");
    const sessions = await room.api(page.request, "/api/account/sessions");
    await room.api(page.request, "/api/account/sessions", "DELETE", { ids: sessions.map((session: { id: string }) => session.id) });
    // 通过真实 API 撤销会话；下一次页面请求发现失效。
    await page.reload();
    await expect(page.getByRole("heading", { name: "欢迎回到开听" })).toBeVisible();
    await page.getByRole("textbox", { name: "用户名", exact: true }).fill("listener");
    await page.getByLabel(/^登录密码/).fill(PERSONAL_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/#\/favorites$/);
  } finally { await admin.dispose(); }
});
