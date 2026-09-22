import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  await app?.close();
  database?.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("HTTP API regressions", () => {
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
    "/api/tracks?limit=abc", "/api/tracks?limit=-1", "/api/tracks?limit=501",
    "/api/tracks?offset=-1", "/api/tracks?offset=1.5", "/api/tracks?favorite=perhaps",
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

  it("returns 404 for an absent playlist without a foreign-key failure", async () => {
    insertTrack();
    const response = await app.inject({ method: "POST", url: "/api/playlists/missing/tracks", headers: { cookie: session }, payload: { trackId: "track-1" } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "未找到资源" });
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
