import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import sharp from "sharp";
import { test as base, expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const ADMIN_PASSWORD = "fixture-admin-password-2026";
export const PERSONAL_PASSWORD = "fixture-listener-password-2026";
export const ALBUM = "试音室 100% / 夜曲";
export const ARTIST = "E2E 艺人 / Artist";
export const titles = { aac: "AAC 晨光", alac: "ALAC 夜色", flac: "FLAC 雨声", mp3: "MP3 星河" };
type RoomOptions = { extraTracks?: number; badAudio?: boolean; metadata?: boolean; autoEnrich?: boolean; artist?: string; discs?: number; onlineLyrics?: boolean; artwork?: boolean; audioDuration?: number; rhythmic?: boolean; mediaConnection?: boolean };
type Upstream = { mode: "unique" | "ambiguous" | "error"; delay: number; requests: string[]; albums: string[]; variants?: Record<string, unknown>[]; lyrics: "found" | "missing" | "error"; lyricsfile?: string };
export type Track = { id: string; title: string; path: string; favorite: boolean; albumKey: string; duration: number };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}
function hashes(directory: string) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, encoding: "utf8" }).sort().flatMap((relative) => {
    const file = path.join(directory, relative);
    return fs.statSync(file).isFile() ? [[relative, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]] : [];
  }));
}
function generateAudio(directory: string, options: RoomOptions, album = ALBUM) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [index, [format, title]] of Object.entries(titles).entries()) {
    const extension = format === "alac" || format === "aac" ? "m4a" : format;
    const file = path.join(directory, `${format}.${extension}`);
    const duration = options.audioDuration ?? 6;
    const signal = options.rhythmic ? `aevalsrc='0.38*sin(2*PI*75*t)*exp(-18*mod(t,0.5))+0.04*sin(2*PI*440*t)':s=44100:d=${duration}` : `sine=frequency=440:duration=${duration}`;
    const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", signal,
      "-c:a", format === "mp3" ? "libmp3lame" : format, "-metadata", `title=${title}`, "-metadata", `album=${album}`,
      "-metadata", `artist=${options.artist ?? ARTIST}`, "-metadata", `album_artist=${options.artist ?? ARTIST}`, "-metadata", `track=${index + 1}`,
      "-metadata", `disc=${1 + index % (options.discs ?? 1)}`, file], { encoding: "utf8", timeout: 15_000 });
    if (result.status !== 0) throw new Error(`生成测试音频失败：${result.stderr || result.error}`);
    if (!options.onlineLyrics || format === "flac") fs.writeFileSync(path.join(directory, `${format}.lrc`), `[00:00.00]${title}\n[00:01.00]第一句测试歌词\n[00:03.00]第二句测试歌词\n`);
  }
  for (let index = 0; index < (options.extraTracks ?? 0); index++) fs.copyFileSync(path.join(directory, "mp3.mp3"), path.join(directory, `extra-${index}.mp3`));
  if (options.badAudio) fs.writeFileSync(path.join(directory, "broken.flac"), "not an audio file");
  for (const file of fs.readdirSync(directory)) fs.chmodSync(path.join(directory, file), 0o444);
}

export class RoomFixture {
  readonly directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "music-e2e-")));
  readonly music = path.join(this.directory, "music");
  readonly data = path.join(this.directory, "data");
  readonly upstream: Upstream = { mode: "unique", delay: 0, requests: [], albums: [ALBUM], lyrics: "found" };
  url = "";
  directMediaOrigin = "";
  directMediaBlocked = false;
  directMediaStalled = false;
  directMediaRequests: { method: string; url: string }[] = [];
  private directMediaServer?: http.Server;
  process: ChildProcess | null = null;
  logs = "";
  private sourceHashes: Record<string, string> = {};
  private upstreamServer?: http.Server;
  private upstreamOrigin = "";
  private secret = randomBytes(32).toString("hex");
  constructor(readonly options: RoomOptions, readonly info: TestInfo) {}
  async start(data = this.data) {
    if (!fs.existsSync(path.join(ROOT, "dist/server/server/index.js"))) throw new Error("请先运行 npm run build");
    if (!this.upstreamServer) {
      generateAudio(this.music, this.options);
      if (this.options.artwork) {
        const width = 3000;
        const pixels = Buffer.alloc(width * width * 3);
        for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
          const index = (y * width + x) * 3;
          pixels[index] = x % 256; pixels[index + 1] = y % 256; pixels[index + 2] = (x ^ y) % 256;
        }
        const cover = path.join(this.music, "cover.jpg");
        await sharp(pixels, { raw: { width, height: width, channels: 3 } }).jpeg({ quality: 95 }).toFile(cover);
        fs.chmodSync(cover, 0o444);
      }
      this.sourceHashes = hashes(this.music);
      this.upstreamServer = http.createServer(async (req, res) => {
        const url = new URL(new URL(req.url!, "http://localhost").searchParams.get("url")!);
        this.upstream.requests.push(url.href);
        const mode = this.upstream.mode;
        await delay(this.upstream.delay);
        res.setHeader("content-type", "application/json");
        if (url.hostname === "lrclib.net") {
          if (this.upstream.lyrics === "error") { res.writeHead(503); res.end('{}'); return; }
          if (this.upstream.lyrics === "missing") { res.writeHead(url.pathname.endsWith("/search") ? 200 : 404); res.end('[]'); return; }
          const title = url.searchParams.get("track_name") ?? titles.aac;
          const lyrics = { trackName: title, artistName: this.options.artist ?? ARTIST, albumName: ALBUM, duration: 6,
            syncedLyrics: `[00:00.00]${title}\n[00:01.00]在线测试歌词第一行\n[00:03.00]在线测试歌词第二行`, lyricsfile: this.upstream.lyricsfile };
          res.end(JSON.stringify(url.pathname.endsWith("/search") ? [lyrics] : lyrics)); return;
        }
        if (mode === "error") { res.writeHead(503); res.end('{"error":"fixture upstream unavailable"}'); return; }
        const variants = this.upstream.variants ?? (mode === "ambiguous" ? [{}, { date: "2019-12-14" }] : [{}]);
        const releases = this.upstream.albums.flatMap((title, albumIndex) => variants.map((changes, index) => ({
          id: `${String(albumIndex * 100 + index).padStart(8, "0")}-cb73-4b2d-a27c-bdfae5235b17`, title, date: "2018-12-14", country: "JP", status: "Official", score: 100,
          "artist-credit": [{ name: ARTIST, artist: { name: ARTIST } }], "track-count": 4,
          media: [{ "track-count": 4, format: "Digital Media", tracks: Object.values(titles).map((title) => ({ title, length: 6000 })) }], genres: [{ name: "jazz", count: 2 }], ...changes
        })));
        res.end(JSON.stringify(url.searchParams.has("query") ? { count: releases.length, releases } : releases.find((release) => url.pathname.endsWith(release.id)) ?? releases[0]));
      });
      this.upstreamServer.listen(0, "127.0.0.1"); await once(this.upstreamServer, "listening");
      this.upstreamOrigin = `http://127.0.0.1:${(this.upstreamServer.address() as net.AddressInfo).port}`;
    }
    const port = await freePort();
    this.url = `http://127.0.0.1:${port}`;
    if (this.options.mediaConnection && !this.directMediaServer) {
      this.directMediaServer = http.createServer((req, res) => {
        this.directMediaRequests.push({ method: req.method ?? "GET", url: req.url ?? "/" });
        if (this.directMediaStalled && req.url?.includes("/stream")) return;
        if (this.directMediaBlocked) { res.writeHead(503); res.end(); return; }
        const upstream = http.request(this.url + req.url, { method: req.method, headers: req.headers }, (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
        });
        upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
      });
      this.directMediaServer.listen(0, "127.0.0.1"); await once(this.directMediaServer, "listening");
      this.directMediaOrigin = `http://127.0.0.1:${(this.directMediaServer.address() as net.AddressInfo).port}`;
    }
    const child = this.process = spawn(process.execPath, ["--import", path.join(ROOT, "e2e/helpers/upstream.mjs"), "dist/server/server/index.js"], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATA_DIR: data, MUSIC_LIBRARY_PATH: this.music, MUSIC_LIBRARY_ROOTS: "",
        ADMIN_PASSWORD, COOKIE_SECRET: this.secret, COOKIE_SECURE: "false", ENABLE_ONLINE_METADATA: String(Boolean(this.options.metadata)),
        PUBLIC_ORIGIN: this.options.mediaConnection ? this.url : undefined, DIRECT_MEDIA_ORIGIN: this.options.mediaConnection ? this.directMediaOrigin : undefined,
        SCAN_ONLINE_METADATA: "false", AUTO_COMPLETE_ALBUM_METADATA: this.options.autoEnrich === undefined ? undefined : String(this.options.autoEnrich), E2E_METADATA_ORIGIN: this.upstreamOrigin }
    });
    child.stdout?.on("data", (value) => { this.logs += value; }); child.stderr?.on("data", (value) => { this.logs += value; });
    let error: Error | undefined; child.on("error", (reason) => { error = reason; });
    for (let attempt = 0; attempt < 150; attempt++) {
      if (error || child.exitCode !== null) throw new Error(`E2E 服务启动失败：${error ?? this.logs}`);
      try { if ((await fetch(`${this.url}/api/health`)).ok) return; } catch { /* 等待端口 */ }
      await delay(100);
    }
    throw new Error(`E2E 服务启动超时：${this.logs}`);
  }
  async stop() {
    const child = this.process; this.process = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "exit"); child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 7_000);
    try { await closed; } finally { clearTimeout(kill); }
  }
  async api(request: APIRequestContext, endpoint: string, method = "GET", data?: unknown) {
    const response = await request.fetch(this.url + endpoint, { method, data });
    expect(response.ok(), `${method} ${endpoint}: ${await response.text()}`).toBe(true);
    return response.json();
  }
  async loginApi(request: APIRequestContext, username = "admin", password = ADMIN_PASSWORD) {
    return this.api(request, "/api/auth/login", "POST", { username, password });
  }
  async scan(request: APIRequestContext) {
    await this.api(request, "/api/directories", "PUT", { path: this.music });
    await expect.poll(async () => (await this.api(request, "/api/scan"))?.status, { timeout: 60_000 }).not.toBe("running");
  }
  addAlbum(title: string) {
    expect(hashes(this.music), "新增测试数据前已有源音乐保持原样").toEqual(this.sourceHashes);
    generateAudio(path.join(this.music, `added-${this.upstream.albums.length}`), {}, title);
    this.upstream.albums.push(title);
    this.sourceHashes = hashes(this.music);
  }
  async ready(page: Page, route = "songs") {
    await this.loginApi(page.request); await this.scan(page.request);
    await page.goto(`${this.url}/#/${route}`);
    await expect(page.locator(".app")).toBeVisible();
    await expect.poll(async () => (await this.api(page.request, "/api/tracks?limit=500")).length).toBeGreaterThan(0);
  }
  async track(request: APIRequestContext, title: string): Promise<Track> {
    const tracks: Track[] = await this.api(request, `/api/tracks?q=${encodeURIComponent(title)}&limit=500`);
    const track = tracks.find((track) => track.title === title);
    if (!track) throw new Error(`未找到 fixture 歌曲：${title}`);
    return track;
  }
  async dispose() {
    try {
      await this.stop();
      if (this.directMediaServer) { this.directMediaServer.closeAllConnections(); await new Promise<void>((resolve) => this.directMediaServer!.close(() => resolve())); }
      if (this.upstreamServer) { this.upstreamServer.closeAllConnections(); await new Promise<void>((resolve) => this.upstreamServer!.close(() => resolve())); }
      if (Object.keys(this.sourceHashes).length) {
        const after = hashes(this.music);
        await this.info.attach("music-hashes.json", { body: JSON.stringify({ before: this.sourceHashes, after }), contentType: "application/json" });
        expect(after, "应用不得改写测试源音乐").toEqual(this.sourceHashes);
      }
      const dbPath = path.join(this.data, "music-library.sqlite");
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        try {
          const integrity = db.pragma("integrity_check");
          await this.info.attach("sqlite-integrity.json", { body: JSON.stringify(integrity), contentType: "application/json" });
          expect(integrity).toEqual([{ integrity_check: "ok" }]);
        } finally { db.close(); }
      }
    } finally {
      await this.info.attach("server.log", { body: this.logs, contentType: "text/plain" });
      await this.info.attach("upstream-requests.json", { body: JSON.stringify(this.upstream.requests), contentType: "application/json" });
      if (this.options.mediaConnection) await this.info.attach("direct-media-requests.json", { body: JSON.stringify(this.directMediaRequests), contentType: "application/json" });
      fs.rmSync(this.directory, { recursive: true, force: true });
    }
  }
}

export const test = base.extend<{ roomOptions: RoomOptions; room: RoomFixture; evidence: void }>({
  roomOptions: [{}, { option: true }],
  room: async ({ roomOptions }, use, info) => {
    const room = new RoomFixture(roomOptions, info);
    try { await room.start(); await use(room); } finally { await room.dispose(); }
  },
  evidence: [async ({ page, room }, use, info) => {
    const network: object[] = []; const errors: string[] = [];
    page.on("request", (request) => { if (request.url().startsWith(room.url)) network.push({ method: request.method(), url: request.url().replace(room.url, ""), range: request.headers().range }); });
    page.on("response", (response) => { if (response.url().startsWith(room.url)) network.push({ status: response.status(), url: response.url().replace(room.url, ""), contentType: response.headers()["content-type"] }); });
    page.on("pageerror", (error) => errors.push(error.message));
    try { await use(); } finally {
      await info.attach("network.json", { body: JSON.stringify(network, null, 2), contentType: "application/json" });
      await info.attach("browser.json", { body: JSON.stringify({ browser: page.context().browser()?.version(), viewport: page.viewportSize(), errors }), contentType: "application/json" });
      if (!page.isClosed()) await info.attach("final.png", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(errors, "浏览器未处理错误").toEqual([]);
    }
  }, { auto: true }]
});
export { expect };

export async function login(page: Page, room: RoomFixture, username = "admin", password = ADMIN_PASSWORD, route = "songs") {
  await page.goto(`${room.url}/#/${route}`);
  await page.getByRole("textbox", { name: "用户名", exact: true }).fill(username);
  await page.getByLabel(/^登录密码/).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}
export async function selectDirectory(page: Page, room: RoomFixture) {
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "选择目录", exact: true }).first().click();
  await page.getByRole("option").filter({ hasText: room.music }).first().click();
  await page.getByRole("button", { name: "选择此目录", exact: true }).click();
}
export const row = (page: Page, title: string) => page.locator(".main-content .track-row").filter({ has: page.getByRole("button", { name: `${title} 的更多操作`, exact: true }) });
export async function createPlaylist(page: Page, name: string) {
  await page.getByRole("button", { name: "新建歌单", exact: true }).first().click();
  await page.getByRole("dialog").getByLabel("歌单名称").fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "创建歌单", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}
export async function addSong(page: Page, title: string) {
  await page.getByRole("button", { name: "添加歌曲", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: new RegExp(title) }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
