import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAuth } from "../src/server/auth.js";
import type { AppConfig } from "../src/server/config.js";
import { openDatabase, type DatabaseHandle } from "../src/server/db.js";
import { registerRoutes } from "../src/server/routes.js";

let root: string;
let config: AppConfig;
let database: DatabaseHandle;
let app: FastifyInstance;
let session: string;

async function startApp() {
  app = Fastify();
  await app.register(cookie);
  await registerAuth(app, config);
  await registerRoutes(app, { config, database, scanner: { isRunning: () => false, scan: async () => undefined } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.adminPassword } });
  session = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
}
function indexArtwork(file: string, id = "art-track") {
  const song = path.join(config.musicLibraryPath, `${id}.mp3`);
  fs.writeFileSync(song, "read-only music");
  database.upsertTrack({ id, path: song, fileName: `${id}.mp3`, title: "封面测试", album: "专辑", artist: "艺人", albumArtist: "艺人",
    genre: null, year: null, trackNo: 1, discNo: 1, duration: 6, bitrate: 128000, codec: "MP3", container: "MPEG", lossless: false,
    formatGroup: "mp3", artworkPath: file, lyricsPath: null, size: 15, mtimeMs: 1 });
}
async function picture(width = 3000, height = width, file = path.join(config.musicLibraryPath, "cover.png"), color = "#ee3366") {
  await sharp({ create: { width, height, channels: 4, background: color } }).png().toFile(file);
  return file;
}
const get = (query = "?size=64", headers: Record<string, string> = {}) => app.inject({ url: `/api/tracks/art-track/artwork${query}`, headers: { cookie: session, ...headers } });
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const cacheFiles = () => fs.readdirSync(config.artworkDir, { recursive: true, encoding: "utf8" }).map((file) => path.join(config.artworkDir, file)).filter((file) => fs.statSync(file).isFile());

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "artwork-api-"));
  const dataDir = path.join(root, "data");
  config = { port: 0, musicLibraryPath: path.join(root, "music"), dataDir, databasePath: ":memory:", artworkDir: path.join(dataDir, "artwork"),
    metadataDir: path.join(dataDir, "metadata"), adminPassword: "test-password", cookieSecret: "artwork-test-only-secret-32-characters", enableOnlineMetadata: false, isProduction: false };
  for (const dir of [config.musicLibraryPath, config.artworkDir, config.metadataDir]) fs.mkdirSync(dir, { recursive: true });
  database = openDatabase(":memory:");
  await startApp();
});
afterEach(async () => { await app?.close(); database?.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("sized artwork HTTP API", () => {
  it("serves a real small WebP, retains original API bytes, and leaves source files unchanged", async () => {
    const source = await picture(); indexArtwork(source);
    const before = hash(source);
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(await sharp(response.rawPayload).metadata()).toMatchObject({ width: 64, height: 64, format: "webp" });
    expect(response.rawPayload.length).toBeLessThan(fs.statSync(source).size / 10);
    expect(response.headers["content-length"]).toBe(String(response.rawPayload.length));
    expect((await get("")).rawPayload).toEqual(fs.readFileSync(source));
    expect(hash(source)).toBe(before);
    expect(fs.readdirSync(config.musicLibraryPath).sort()).toEqual(["art-track.mp3", "cover.png"]);
  });

  it("keeps aspect ratio, transparency and orientation without enlarging a small original", async () => {
    const source = await picture(40, 20, undefined, "#00000000"); indexArtwork(source);
    expect(await sharp((await get("?size=128")).rawPayload).metadata()).toMatchObject({ width: 40, height: 20, hasAlpha: true });
    await sharp({ create: { width: 120, height: 60, channels: 3, background: "#336699" } }).withMetadata({ orientation: 6 }).jpeg().toFile(source + ".jpg");
    database.db.prepare("UPDATE tracks SET artwork_path = ?").run(source + ".jpg");
    expect(await sharp((await get()).rawPayload).metadata()).toMatchObject({ width: 32, height: 64 });
  });

  it("coalesces requests, shares source caches across songs and restarts, and invalidates changed covers", async () => {
    const source = await picture(); indexArtwork(source); indexArtwork(source, "same-album");
    const responses = await Promise.all(Array.from({ length: 6 }, () => get()));
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(new Set(responses.map((response) => response.headers.etag)).size).toBe(1);
    const etag = String(responses[0].headers.etag);
    const cached = cacheFiles(); expect(cached).toHaveLength(1);
    const modified = fs.statSync(cached[0]).mtimeMs;
    const other = await app.inject({ url: "/api/tracks/same-album/artwork?size=64", headers: { cookie: session } });
    expect(other.headers.etag).toBe(etag);
    await app.close(); await startApp();
    const repeat = await get("?size=64", { "if-none-match": `"unrelated", W/${etag}` });
    expect(repeat.statusCode).toBe(304); expect(repeat.rawPayload.length).toBe(0);
    expect(String(repeat.headers["cache-control"])).toContain("private");
    expect(String(repeat.headers["cache-control"])).toContain("no-cache");
    expect(fs.statSync(cached[0]).mtimeMs).toBe(modified);
    await picture(3000, 3000, source, "#3366ee");
    const replaced = await get("?size=64", { "if-none-match": etag });
    expect(replaced.statusCode).toBe(200); expect(replaced.headers.etag).not.toBe(etag);
    expect(replaced.rawPayload).not.toEqual(responses[0].rawPayload);
  });

  it.each(["0", "-1", "65", "999999", "abc", "Infinity", "64.5", "64&size=128"])("rejects unbounded or invalid sizes: %s", async (size) => {
    indexArtwork(await picture(40));
    expect((await get(`?size=${size}`)).statusCode).toBe(400);
    expect(cacheFiles()).toHaveLength(0);
  });

  it("checks authorization and source availability even after a thumbnail was cached", async () => {
    const source = await picture(); indexArtwork(source);
    const cached = await get(); expect(cached.statusCode).toBe(200);
    const anonymous = await app.inject({ url: "/api/tracks/art-track/artwork?size=64", headers: { "if-none-match": String(cached.headers.etag) } });
    expect(anonymous.statusCode).toBe(401);
    expect((await app.inject({ url: "/api/tracks/missing/artwork?size=64", headers: { cookie: session } })).statusCode).toBe(404);
    fs.unlinkSync(source);
    expect((await get()).statusCode).toBe(404);
  });

  it.each(["source", "cache-directory", "cache-file"])("does not follow an escaping %s symlink", async (kind) => {
    const source = await picture(); indexArtwork(source);
    const outside = path.join(root, "private.png"); fs.writeFileSync(outside, "private-data");
    if (kind === "source") { fs.unlinkSync(source); fs.symlinkSync(outside, source); }
    else {
      expect((await get()).statusCode).toBe(200);
      const cached = cacheFiles()[0];
      if (kind === "cache-file") { fs.unlinkSync(cached); fs.symlinkSync(outside, cached); }
      else { fs.rmSync(path.dirname(cached), { recursive: true }); fs.symlinkSync(root, path.dirname(cached)); }
    }
    const response = await get();
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain("private-data"); expect(response.body).not.toContain(root);
    expect(fs.readFileSync(outside, "utf8")).toBe("private-data");
    expect(fs.readdirSync(root).sort()).toEqual(["data", "music", "private.png"]);
  });

  it.each(["not an image", '<svg xmlns="http://www.w3.org/2000/svg" width="9000" height="9000"><rect width="9000" height="9000" fill="red"/></svg>'])("rejects damaged or excessive images, removes partial files, and recovers", async (contents) => {
    const source = path.join(config.artworkDir, "embedded.png"); fs.writeFileSync(source, contents); indexArtwork(source);
    const response = await get();
    expect(response.statusCode).toBe(422); expect(response.body).not.toContain(root);
    expect(cacheFiles()).toEqual([source]);
    await picture(40, 40, source);
    expect((await get()).statusCode).toBe(200);
  });
});
