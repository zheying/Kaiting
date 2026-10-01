import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import sharp from "sharp";
import { test, expect, titles, createPlaylist, addSong, login, ROOT } from "./helpers/room.js";

test("CLI 备份恢复到新目录后，页面读回收藏歌单和重定位的封面缓存", async ({ page, room }, info) => {
  await room.ready(page);
  const song = await room.track(page.request, titles.aac);
  const [album] = await room.api(page.request, "/api/albums");
  await page.getByRole("button", { name: `收藏 ${titles.aac}`, exact: true }).click();
  await createPlaylist(page, "恢复后继续听"); await addSong(page, titles.aac);
  const [playlist] = await room.api(page.request, "/api/playlists");
  await room.stop();
  const transcripts: object[] = [];
  const cli = (entry: string, args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, "dist/server/server", entry), ...args], { cwd: ROOT, encoding: "utf8", timeout: 20_000 });
    transcripts.push({ entry, args, status: result.status, stdout: result.stdout, stderr: result.stderr });
    expect(result.status, result.stderr).toBe(0); return result.stdout;
  };
  // 合成可完整解码的 PNG，并让恢复后的页面实际走缩略图缩放。
  const image = path.join(room.directory, "cover.png");
  const png = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#758f83" } }).png().toBuffer();
  fs.writeFileSync(image, png);
  cli("artwork-import.js", ["--data-dir", room.data, "--album-key", album.key, "--file", image, "--source-url", "https://example.test/fixture.png"]);
  const output = cli("maintenance.js", ["backup", "--data-dir", room.data, "--backup-root", path.join(room.directory, "backups"), "--music-library-path", room.music]);
  const backup = output.trim().replace(/^备份完成：/, "");
  const restored = path.join(room.directory, "restored");
  cli("maintenance.js", ["restore", "--backup", backup, "--data-dir", restored, "--music-library-path", room.music]);
  const db = new Database(path.join(restored, "music-library.sqlite"), { readonly: true });
  try {
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    const track = db.prepare("SELECT artwork_path, path FROM tracks WHERE id = ?").get(song.id) as { artwork_path: string; path: string };
    expect(track.path).toBe(song.path); expect(track.artwork_path.startsWith(restored + path.sep)).toBe(true);
    expect(fs.readFileSync(track.artwork_path)).toEqual(png);
  } finally { db.close(); }
  await info.attach("maintenance-cli.json", { body: JSON.stringify(transcripts, null, 2), contentType: "application/json" });
  await info.attach("backup-manifest.json", { path: path.join(backup, "manifest.json"), contentType: "application/json" });
  await page.context().clearCookies(); await room.start(restored);
  await login(page, room, undefined, undefined, "favorites");
  await expect(page.locator(".main-content .track-identity strong")).toHaveText([titles.aac]);
  await page.goto(`${room.url}/#/playlist/${playlist.id}`);
  await expect(page.getByRole("heading", { name: "恢复后继续听", exact: true })).toBeVisible();
  await expect(page.locator(".playlist-tracks .track-identity strong")).toHaveText([titles.aac]);
  const cover = await page.request.get(`${room.url}/api/tracks/${song.id}/artwork`);
  expect(cover.ok()).toBe(true); expect(await cover.body()).toEqual(png);
  const thumbnail = await page.request.get(`${room.url}/api/tracks/${song.id}/artwork?size=64`);
  expect(thumbnail.status()).toBe(200);
  expect(thumbnail.headers()["content-type"]).toBe("image/webp");
  const { info: thumbnailInfo } = await sharp(await thumbnail.body()).raw().toBuffer({ resolveWithObject: true });
  expect([thumbnailInfo.width, thumbnailInfo.height]).toEqual([64, 64]);
  const playlistCover = page.locator(".playlist-tracks img").first();
  await expect(playlistCover).toBeVisible();
  await expect(playlistCover).toHaveJSProperty("complete", true);
  await expect.poll(() => playlistCover.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await info.attach("restored-artwork.json", {
    body: JSON.stringify({
      thumbnail: { status: thumbnail.status(), contentType: thumbnail.headers()["content-type"], width: thumbnailInfo.width, height: thumbnailInfo.height },
      displayed: await playlistCover.evaluate((image: HTMLImageElement) => ({ src: image.currentSrc, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })),
    }, null, 2),
    contentType: "application/json",
  });
});
