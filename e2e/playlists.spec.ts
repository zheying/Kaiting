import { test, expect, titles, createPlaylist, addSong, PERSONAL_PASSWORD } from "./helpers/room.js";

test("歌单完整编辑、键盘和指针排序、刷新与删除，保留音乐和收藏", async ({ page, room }) => {
  await room.ready(page);
  await page.getByRole("button", { name: `收藏 ${titles.aac}`, exact: true }).click();
  await createPlaylist(page, "夜间播放");
  for (const title of [titles.aac, titles.alac, titles.flac]) await addSong(page, title);
  await page.getByRole("button", { name: "调整顺序", exact: true }).click();
  const handle = page.getByRole("button", { name: `调整 ${titles.aac} 的位置`, exact: true });
  await handle.press("Space"); await handle.press("End"); await handle.press("Space");
  await expect(page.locator(".order-track strong")).toHaveText([titles.alac, titles.flac, titles.aac]);
  const from = await page.getByRole("button", { name: `调整 ${titles.aac} 的位置`, exact: true }).boundingBox();
  const to = await page.getByRole("button", { name: `调整 ${titles.alac} 的位置`, exact: true }).boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2); await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 }); await page.mouse.up();
  await expect(page.locator(".order-track strong")).toHaveText([titles.aac, titles.alac, titles.flac]);
  await page.getByRole("button", { name: "保存顺序", exact: true }).click();
  await expect(page.getByRole("button", { name: "调整顺序", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".playlist-tracks .track-identity strong")).toHaveText([titles.aac, titles.alac, titles.flac]);
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page.getByRole("dialog").getByLabel("歌单名称").fill("新的夜间播放");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.getByRole("heading", { name: "新的夜间播放" })).toBeVisible();
  await page.getByRole("button", { name: `从歌单移除 ${titles.alac}`, exact: true }).click();
  await expect(page.locator(".playlist-tracks .track-row")).toHaveCount(2);
  await page.getByRole("button", { name: "删除歌单", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除歌单", exact: true }).click();
  await expect(page.getByRole("heading", { name: "还没有私人歌单" })).toBeVisible();
  expect(await room.api(page.request, "/api/tracks")).toHaveLength(4);
  expect(await room.api(page.request, "/api/tracks?favorite=true")).toHaveLength(1);
});

for (const failure of ["lost-create", "failed-add"] as const) {
  test(`${failure} 后从页面重试，不重复创建歌单或歌曲`, async ({ page, room }) => {
    await room.ready(page);
    let failed = false;
    await page.route("**/api/playlists**", async (route) => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      if (!failed && request.method() === "POST" && (failure === "lost-create" ? path === "/api/playlists" : /\/tracks$/.test(path))) {
        failed = true;
        if (failure === "lost-create") { await route.fetch(); await route.abort("failed"); }
        else await route.fulfill({ status: 503, json: { error: "测试：添加暂不可用" } });
      } else await route.continue();
    });
    await page.getByRole("button", { name: `${titles.aac} 的更多操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: "添加到歌单" }).click();
    await page.getByRole("button", { name: "创建新歌单", exact: true }).click();
    await page.getByLabel("歌单名称").fill("重试保留");
    await page.getByRole("button", { name: "创建歌单", exact: true }).dblclick();
    await expect(page.getByRole("button", { name: "重试保存", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: "重试保留", exact: true })).toBeVisible();
    const lists = await room.api(page.request, "/api/playlists");
    expect(lists).toHaveLength(1); expect(lists[0].trackCount).toBe(1);
  });
}

test("排序版本冲突保留草稿，其他账号不能读取或修改私人歌单", async ({ page, room, playwright }) => {
  await room.ready(page); await createPlaylist(page, "并发编辑"); await addSong(page, titles.aac); await addSong(page, titles.alac);
  const [playlist] = await room.api(page.request, "/api/playlists");
  await page.getByRole("button", { name: "调整顺序", exact: true }).click();
  const handle = page.getByRole("button", { name: `调整 ${titles.aac} 的位置`, exact: true });
  await handle.press("Space"); await handle.press("End"); await handle.press("Space");
  await room.api(page.request, `/api/playlists/${playlist.id}`, "PATCH", { name: "其他设备的新名称" });
  await page.getByRole("button", { name: "保存顺序", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试保存", exact: true })).toBeVisible();
  await expect(page.locator(".order-track strong")).toHaveText([titles.alac, titles.aac]);
  const created = await room.api(page.request, "/api/admin/users", "POST", { username: "other", displayName: "其他听众", role: "member" });
  const other = await playwright.request.newContext();
  try {
    await room.loginApi(other, "other", created.temporaryPassword);
    await room.api(other, "/api/auth/password", "POST", { currentPassword: created.temporaryPassword, password: PERSONAL_PASSWORD });
    expect((await other.get(`${room.url}/api/playlists/${playlist.id}`)).status()).toBe(404);
    expect((await other.delete(`${room.url}/api/playlists/${playlist.id}`)).status()).toBe(404);
    expect((await room.api(page.request, `/api/playlists/${playlist.id}`)).playlist.name).toBe("其他设备的新名称");
  } finally { await other.dispose(); }
});
