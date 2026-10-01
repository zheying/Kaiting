import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "../src/server/auth.js";
import { openDatabase, type DatabaseHandle } from "../src/server/db.js";
import { registerRoutes } from "../src/server/routes.js";
import type { AppConfig } from "../src/server/config.js";

// 需求边界：仅指定入口可握手；媒体凭证不能读私人数据或写入；
// 伪造、超时、重放、退出、停用和首次改密均不能绕过原有账号保护。
const publicOrigin = "https://music.example.test";
const directOrigin = "https://direct.music.example.test:5443";
const publicHost = new URL(publicOrigin).host;
const directHost = new URL(directOrigin).host;
let root: string, config: AppConfig, db: DatabaseHandle, app: FastifyInstance, session: string;
const request = (url: string, options: Partial<InjectOptions> = {}) => app.inject({ url, ...options });
const primary = (url: string, method: InjectOptions["method"] = "GET", payload?: Record<string, unknown>, login = session) => request(url, {
  method, headers: { host: publicHost, origin: publicOrigin, cookie: login }, ...(payload === undefined ? {} : { payload })
});
const direct = (url: string, method: InjectOptions["method"] = "GET", payload?: Record<string, unknown>, mediaCookie = "") => request(url, {
  method, headers: { host: directHost, origin: publicOrigin, cookie: mediaCookie }, ...(payload === undefined ? {} : { payload })
});
async function login(username: string, password: string) {
  const r = await primary("/api/auth/login", "POST", { username, password }, "");
  expect(r.statusCode).toBe(200);
  return r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
async function grant(loginCookie = session) {
  const issued = await primary("/api/media/connection", "POST", {}, loginCookie);
  expect(issued.statusCode).toBe(200);
  return issued.json<{ ticket: string }>().ticket;
}
async function connect(loginCookie = session) {
  const response = await direct("/api/media/connect", "POST", { ticket: await grant(loginCookie) });
  expect(response.statusCode).toBe(200);
  return { response, cookie: response.cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "music-direct-test-")));
  config = { port: 0, musicLibraryPath: path.join(root, "music"), dataDir: path.join(root, "data"), databasePath: path.join(root, "data/library.sqlite"),
    artworkDir: path.join(root, "data/artwork"), metadataDir: path.join(root, "data/metadata"), adminPassword: "fixture-admin-password",
    cookieSecret: "isolated-media-connection-secret-at-least-32", cookieSecure: false, enableOnlineMetadata: false, isProduction: false,
    mediaConnection: { publicOrigin, directOrigin } };
  for (const dir of [config.musicLibraryPath, config.artworkDir, config.metadataDir]) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(config.musicLibraryPath, "one.mp3"); fs.writeFileSync(file, "0123456789");
  db = openDatabase(config.databasePath);
  db.upsertTrack({ id: "one", path: file, fileName: "one.mp3", title: "独立测试音轨", album: "测试专辑", artist: "测试艺人", albumArtist: "测试艺人",
    genre: null, year: null, trackNo: 1, discNo: 1, duration: 30, bitrate: 128000, codec: "MP3", container: "MPEG", lossless: false,
    formatGroup: "mp3", artworkPath: null, lyricsPath: null, size: 10, mtimeMs: 1 });
  app = Fastify(); await app.register(cookie); await registerAuth(app, config, db);
  await registerRoutes(app, { config, database: db, scanner: { isRunning: () => false, scan: vi.fn(), stop: vi.fn() } });
  session = await login("admin", config.adminPassword);
});
afterEach(async () => { vi.useRealTimers(); await app.close(); db.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("NAS 媒体授权与隔离", () => {
  it("只向已登录的正式入口提供配置，探测必须匹配来源与服务实例", async () => {
    expect((await primary("/api/media/connection", "GET", undefined, "")).statusCode).toBe(401);
    const settings = (await primary("/api/media/connection")).json();
    expect(settings).toMatchObject({ enabled: true, publicOrigin, directOrigin });
    const probe = await direct("/api/media/probe");
    expect(probe.statusCode).toBe(200); expect(probe.json().instance).toBe(settings.instance);
    expect(probe.headers["access-control-allow-origin"]).toBe(publicOrigin);
    expect((await request("/api/media/probe", { headers: { host: directHost, origin: "https://untrusted.example" } })).statusCode).toBe(403);
    expect((await request("/api/media/connection", { headers: { host: "other.example", cookie: session } })).json()).toEqual({ enabled: false });
  });
  it("媒体预检只许可指定来源与方法，不扩大普通 API 的跨域写入权限", async () => {
    const allowed = await request("/api/tracks/one/stream", { method: "OPTIONS", headers: { host: directHost, origin: publicOrigin, "access-control-request-method": "GET", "access-control-request-headers": "range" } });
    expect(allowed.statusCode).toBe(204); expect(allowed.headers["access-control-allow-origin"]).toBe(publicOrigin);
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    const denied = await request("/api/tracks/one/stream", { method: "OPTIONS", headers: { host: directHost, origin: "https://untrusted.example", "access-control-request-method": "GET" } });
    expect(denied.statusCode).toBe(403); expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    const write = await request("/api/playlists", { method: "POST", headers: { host: directHost, origin: publicOrigin, cookie: session }, payload: { name: "不应创建" } });
    expect([401, 403, 404]).toContain(write.statusCode); expect(db.listPlaylists()).toHaveLength(0);
  });
  it("使用只读媒体 Cookie 获取 Range，普通登录 Cookie 不能代替直连握手", async () => {
    expect((await direct("/api/tracks/one/stream", "GET", undefined, session)).statusCode).toBe(401);
    const linked = await connect();
    const cookie = linked.response.cookies[0];
    expect(cookie).toMatchObject({ name: "ml_media", httpOnly: true, secure: true, sameSite: "Strict", path: "/api/" });
    expect(cookie.domain).toBeUndefined();
    const response = await request("/api/tracks/one/stream", { headers: { host: directHost, origin: publicOrigin, cookie: linked.cookie, range: "bytes=2-5" } });
    expect(response.statusCode).toBe(206); expect(response.body).toBe("2345");
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    expect(response.headers["access-control-allow-origin"]).toBe(publicOrigin);
    expect((await direct("/api/media/status", "GET", undefined, linked.cookie)).statusCode).toBe(200);
    for (const url of ["/api/me", "/api/playlists", "/api/tracks", "/api/admin/users"]) {
      expect((await primary(url, "GET", undefined, linked.cookie)).statusCode).toBe(401);
    }
    expect(fs.readFileSync(path.join(config.musicLibraryPath, "one.mp3"), "utf8")).toBe("0123456789");
  });
  it("拒绝票据篡改、过期和重复使用，凭证不进入媒体 URL", async () => {
    const ticket = await grant();
    expect((await direct("/api/media/connect", "POST", { ticket: ticket + "x" })).statusCode).toBe(401);
    const accepted = await direct("/api/media/connect", "POST", { ticket });
    expect(accepted.statusCode).toBe(200);
    expect((await direct("/api/media/connect", "POST", { ticket })).statusCode).toBe(401);
    const expired = await grant();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 120_000);
    expect((await direct("/api/media/connect", "POST", { ticket: expired })).statusCode).toBe(401);
    expect(accepted.json()).not.toHaveProperty("ticket");
    expect(accepted.json()).not.toHaveProperty("url");
  });
  it("账号退出后媒体凭证立即不能发起新的读取", async () => {
    const linked = await connect();
    expect((await primary("/api/auth/logout", "POST", {})).statusCode).toBe(200);
    expect((await direct("/api/tracks/one/stream", "GET", undefined, linked.cookie)).statusCode).toBe(401);
    expect((await direct("/api/media/status", "GET", undefined, linked.cookie)).statusCode).toBe(401);
  });
  it("首次改密限制和停用账号同样约束直连票据与读取", async () => {
    const created = (await primary("/api/admin/users", "POST", { username: "listener", displayName: "听众", role: "member" })).json();
    const listener = await login("listener", created.temporaryPassword);
    expect((await primary("/api/media/connection", "POST", {}, listener)).statusCode).toBe(403);
    expect((await primary("/api/auth/password", "POST", { currentPassword: created.temporaryPassword, password: "new-listener-password" }, listener)).statusCode).toBe(200);
    const linked = await connect(listener);
    const pending = await grant(listener);
    expect((await primary(`/api/admin/users/${created.user.id}`, "PATCH", { status: "disabled" })).statusCode).toBe(200);
    expect((await direct("/api/media/connect", "POST", { ticket: pending })).statusCode).toBe(401);
    expect((await direct("/api/tracks/one/stream", "GET", undefined, linked.cookie)).statusCode).toBe(401);
  });
});
