import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "../src/server/auth.js";
import type { AppConfig } from "../src/server/config.js";
import { openDatabase, type DatabaseHandle, type UpsertTrack } from "../src/server/db.js";
import { registerRoutes } from "../src/server/routes.js";

let directory: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let config: AppConfig;
let session: string;

function insertTrack(overrides: Partial<UpsertTrack> = {}) {
  const track: UpsertTrack = {
    id: "track-1", path: path.join(config.musicLibraryPath, "song.mp3"), fileName: "song.mp3",
    title: 'Love-Song 夜曲 100% Live (2026) He said "hello"',
    album: "100% Love / 夜曲", artist: "100% Artist / 艺人", albumArtist: "100% Artist / 艺人",
    genre: "Pop", year: 2026, trackNo: 1, discNo: 1, duration: 1, bitrate: 128000,
    codec: "MP3", container: "MPEG", lossless: false, formatGroup: "mp3",
    artworkPath: null, lyricsPath: null, size: 10, mtimeMs: 1, ...overrides
  };
  fs.writeFileSync(track.path, "0123456789");
  database.upsertTrack(track);
  return track;
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-routes-"));
  config = {
    port: 0, musicLibraryPath: path.join(directory, "music"), dataDir: directory,
    databasePath: ":memory:", artworkDir: path.join(directory, "artwork"),
    metadataDir: path.join(directory, "metadata"), adminPassword: "test-password",
    cookieSecret: "route-tests-secret-with-at-least-32-characters", enableOnlineMetadata: false, isProduction: false
  };
  fs.mkdirSync(config.musicLibraryPath);
  fs.mkdirSync(config.artworkDir);
  fs.mkdirSync(config.metadataDir);
  database = openDatabase(":memory:");
  app = Fastify();
  await app.register(cookie);
  await registerAuth(app, config);
  await registerRoutes(app, {
    config, database, scanner: { isRunning: () => false, scan: async () => undefined }
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.adminPassword } });
  expect(login.statusCode).toBe(200);
  session = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  database?.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("HTTP API regressions", () => {
  it("looks up missing lyrics automatically and refreshes a cached miss on request", async () => {
    config.enableOnlineMetadata = true;
    const song = insertTrack({ title: "Fixture Song", artist: "Fixture Artist", album: "Fixture Album", duration: 181 });
    let available = false;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (available) return Response.json({ trackName: song.title, artistName: song.artist, albumName: song.album,
        duration: 181, syncedLyrics: "[00:01.00]自动查询测试歌词" });
      return url.pathname.endsWith("/search") ? Response.json([]) : new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    const get = (query = "") => app.inject({ url: `/api/tracks/${song.id}/lyrics${query}`, headers: { cookie: session } });
    expect((await get()).statusCode).toBe(404);
    expect(fetcher).toHaveBeenCalled();
    const requests = fetcher.mock.calls.length;
    available = true;
    expect((await get()).statusCode).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    const refreshed = await get("?search=1");
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.body).toContain("自动查询测试歌词");
    expect(database.getTrack(song.id)?.hasLyrics).toBe(true);
    expect((await get()).body).toBe(refreshed.body);
  });

  it("reports a lyrics provider failure as retryable and recovers without a negative cache", async () => {
    config.enableOnlineMetadata = true;
    insertTrack();
    const fetcher = vi.fn().mockRejectedValue(new Error("fixture disconnected"));
    vi.stubGlobal("fetch", fetcher);
    const get = () => app.inject({ url: "/api/tracks/track-1/lyrics", headers: { cookie: session } });
    expect((await get()).statusCode).toBe(503);
    expect(database.metadataCacheCount()).toBe(0);
    fetcher.mockImplementation(async () => Response.json({ trackName: database.getTrack("track-1")!.title,
      artistName: "100% Artist / 艺人", duration: 1, syncedLyrics: "[00:00.00]恢复连接后的歌词" }));
    expect((await get()).statusCode).toBe(200);
  });

  it("keeps local lyrics and the online opt-out authoritative", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const song = insertTrack();
    const get = () => app.inject({ url: `/api/tracks/${song.id}/lyrics?search=1`, headers: { cookie: session } });
    expect((await get()).statusCode).toBe(404);
    config.enableOnlineMetadata = true;
    const local = path.join(config.musicLibraryPath, "song.lrc");
    fs.writeFileSync(local, "[00:00.00]本地优先");
    database.setTrackLyricsPath(song.id, local);
    expect((await get()).body).toBe("[00:00.00]本地优先");
    expect(fetcher).not.toHaveBeenCalled();
    const outside = path.join(directory, "private.lrc");
    fs.writeFileSync(outside, "must not leak"); fs.unlinkSync(local); fs.symlinkSync(outside, local);
    const escaped = await get();
    expect(escaped.statusCode).not.toBe(200);
    expect(escaped.body).not.toContain("must not leak");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("serves real word-timed lyrics as JSON while retaining the text API and cached timings", async () => {
    config.enableOnlineMetadata = true;
    const song = insertTrack({ title: "测试曲", artist: "测试艺人", duration: 6 });
    const fetcher = vi.fn(async () => Response.json({ trackName: song.title, artistName: song.artist, duration: 6,
      syncedLyrics: "[00:01.00]风 停了", lyricsfile: JSON.stringify({ version: "1.0",
        metadata: { title: song.title, artist: song.artist }, lines: [{ text: "风 停了", start_ms: 1000,
          words: [{ text: "风 ", start_ms: 1000, end_ms: 1500 }, { text: "停了", start_ms: 3000, end_ms: 5000 }] }] }) }));
    vi.stubGlobal("fetch", fetcher);
    const get = (query = "") => app.inject({ url: `/api/tracks/${song.id}/lyrics${query}`, headers: { cookie: session } });
    const result = await get("?format=json");
    expect(result.statusCode).toBe(200);
    expect(result.json().lines[0].words[1]).toEqual({ text: "停了", time: 3, end: 5 });
    expect(result.body).not.toContain(config.dataDir);
    const requests = fetcher.mock.calls.length;
    expect((await get()).body).toContain("[00:01.00]风 停了");
    expect((await get("?format=json")).json()).toEqual(result.json());
    expect(fetcher).toHaveBeenCalledTimes(requests);
    expect((await app.inject({ url: `/api/tracks/${song.id}/lyrics?format=json` })).statusCode).toBe(401);
  });

  it("upgrades old lyrics caches once and preserves them with bounded retries during outages", async () => {
    config.enableOnlineMetadata = true;
    const song = insertTrack({ title: "测试曲", artist: "测试艺人" });
    const old = path.join(config.metadataDir, "online-track-1.lrc");
    fs.writeFileSync(old, "[00:00.00]已有歌词"); database.setTrackLyricsPath(song.id, old);
    const fetcher = vi.fn().mockRejectedValue(new Error("fixture offline")); vi.stubGlobal("fetch", fetcher);
    const get = (refresh = "") => app.inject({ url: `/api/tracks/${song.id}/lyrics?format=json${refresh}`, headers: { cookie: session } });
    expect((await get()).json().lines[0].text).toBe("已有歌词");
    const requests = fetcher.mock.calls.length;
    expect(requests).toBeGreaterThan(0);
    expect((await get()).json().lines[0].words).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(requests);
    fetcher.mockImplementation(async () => Response.json({ trackName: song.title, artistName: song.artist, syncedLyrics: "[00:00.00]新歌词" }));
    expect((await get("&search=1")).json().lines[0].text).toBe("新歌词");
    const upgraded = fetcher.mock.calls.length;
    expect((await get()).json().lines[0].text).toBe("新歌词");
    expect(fetcher).toHaveBeenCalledTimes(upgraded);
    expect(fs.readFileSync(old, "utf8")).toBe("[00:00.00]已有歌词");
  });

  it("invalid word lyrics fall back to LRC and local JSON reads stay offline and read-only", async () => {
    config.enableOnlineMetadata = true;
    const song = insertTrack({ title: "测试曲", artist: "测试艺人" });
    const fetcher = vi.fn(async () => Response.json({ trackName: song.title, artistName: song.artist,
      lyricsfile: "version: unknown", syncedLyrics: "[00:00.00]逐句回退" })); vi.stubGlobal("fetch", fetcher);
    const get = () => app.inject({ url: `/api/tracks/${song.id}/lyrics?format=json`, headers: { cookie: session } });
    expect((await get()).json()).toEqual({ lines: [{ text: "逐句回退", time: 0 }] });
    const local = path.join(config.musicLibraryPath, "test.lrc");
    fs.writeFileSync(local, "[00:00.00]本地歌词"); database.setTrackLyricsPath(song.id, local);
    const requests = fetcher.mock.calls.length;
    expect((await get()).json()).toEqual({ lines: [{ text: "本地歌词", time: 0 }] });
    expect(fetcher).toHaveBeenCalledTimes(requests);
    expect(fs.readFileSync(local, "utf8")).toBe("[00:00.00]本地歌词");
  });

  it.each(["Love-Song", "夜曲", "100%", "(2026)", '"hello"', "Love Son"])("searches ordinary text: %s", async (query) => {
    insertTrack();
    const response = await app.inject({ url: `/api/search?q=${encodeURIComponent(query)}`, headers: { cookie: session } });
    expect(response.statusCode).toBe(200);
    expect(response.json().tracks.map((track: { id: string }) => track.id)).toEqual(["track-1"]);
  });

  it.each(["-", '"', "()", "***", "OR", "title:missing"])("does not interpret query syntax: %s", async (query) => {
    insertTrack();
    const response = await app.inject({ url: `/api/search?q=${encodeURIComponent(query)}`, headers: { cookie: session } });
    expect(response.statusCode).toBe(200);
    expect(response.json().tracks).toEqual([]);
  });

  it("opens encoded percent, slash and Chinese album/artist names exactly once", async () => {
    const track = insertTrack();
    const album = database.listAlbums()[0];
    for (const url of [`/api/albums/${encodeURIComponent(album.key)}`, `/api/artists/${encodeURIComponent(track.artist!)}`]) {
      const response = await app.inject({ url, headers: { cookie: session } });
      expect(response.statusCode).toBe(200);
      expect(response.json().tracks[0].id).toBe(track.id);
    }
  });

  it.each([
    "/api/tracks?limit=abc", "/api/tracks?favorite=perhaps",
    "/api/scan/errors?limit=Infinity", "/api/tracks/track-1/stream?start=Infinity",
    "/api/tracks/track-1/stream?start=-1", "/api/tracks/track-1/stream?mode=invalid"
  ])("rejects invalid parameters without a server error: %s", async (url) => {
    const response = await app.inject({ url, headers: { cookie: session } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "请求参数不正确，请检查后重试" });
  });

  it("keeps favorite filtering when searching and accepts valid pagination", async () => {
    insertTrack();
    insertTrack({ id: "track-2", path: path.join(config.musicLibraryPath, "second.mp3") });
    database.toggleFavorite("track-2", true);
    const response = await app.inject({ url: "/api/tracks?q=Love&favorite=true&limit=1&offset=0", headers: { cookie: session } });
    expect(response.statusCode).toBe(200);
    expect(response.json().map((track: { id: string }) => track.id)).toEqual(["track-2"]);
  });

  it.each(["", "   "])("treats an empty search as an unfiltered track list: %j", async (query) => {
    insertTrack();
    const response = await app.inject({ url: `/api/tracks?q=${encodeURIComponent(query)}`, headers: { cookie: session } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
  });

  it("validates mutation payloads before touching the database", async () => {
    const track = insertTrack();
    database.toggleFavorite(track.id, true);
    const favorite = await app.inject({ method: "PATCH", url: `/api/tracks/${track.id}/favorite`, headers: { cookie: session }, payload: {} });
    const playlist = await app.inject({ method: "POST", url: "/api/playlists", headers: { cookie: session }, payload: { name: {} } });
    expect(favorite.statusCode).toBe(400);
    expect(playlist.statusCode).toBe(400);
    expect(database.getTrack(track.id)?.favorite).toBe(true);
    expect(database.listPlaylists()).toEqual([]);
  });

  it.each([null, 0, "false", [false]])("does not coerce an invalid favorite body into a mutation: %j", async (favorite) => {
    insertTrack();
    database.toggleFavorite("track-1", true);
    const response = await app.inject({ method: "PATCH", url: "/api/tracks/track-1/favorite", headers: { cookie: session }, payload: { favorite } });
    expect(response.statusCode).toBe(400);
    expect(database.getTrack("track-1")?.favorite).toBe(true);
  });

  it.each([null, 42, true, ["name"]])("rejects a non-string playlist name: %j", async (name) => {
    const response = await app.inject({ method: "POST", url: "/api/playlists", headers: { cookie: session }, payload: { name } });
    expect(response.statusCode).toBe(400);
    expect(database.listPlaylists()).toEqual([]);
  });

  it.each([
    ["song.mp3", "MP3", "MPEG", "mp3", "audio/mpeg"],
    ["song.m4a", "AAC", "MPEG-4", "m4a", "audio/mp4"]
  ])("sends actual direct bytes for %s over HTTP", async (filename, codec, container, formatGroup, mime) => {
    const track = insertTrack({ path: path.join(config.musicLibraryPath, filename), codec, container, formatGroup });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/tracks/${track.id}/stream`, { headers: { cookie: session } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(mime);
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("0123456789");
    const partial = await fetch(`${address}/api/tracks/${track.id}/stream`, { headers: { cookie: session, range: "bytes=2-4" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await partial.text()).toBe("234");
  });

  it("reports missing media as a recoverable 404 without exposing paths", async () => {
    const track = insertTrack();
    fs.unlinkSync(track.path);
    const response = await app.inject({ url: `/api/tracks/${track.id}/stream`, headers: { cookie: session } });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(directory);
  });

  it("does not stream a symlink that escapes the read-only library", async () => {
    const track = insertTrack();
    const outside = path.join(directory, "outside.mp3");
    fs.writeFileSync(outside, "private-data");
    fs.unlinkSync(track.path);
    fs.symlinkSync(outside, track.path);
    const response = await app.inject({ url: `/api/tracks/${track.id}/stream`, headers: { cookie: session } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "服务暂时不可用，请稍后重试" });
    expect(response.body).not.toContain("private-data");
    expect(response.body).not.toContain(directory);
  });
});
