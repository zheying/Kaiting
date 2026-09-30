import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/client/api.js";
import { openDatabase, type DatabaseHandle } from "../src/server/db.js";
import { registerRoutes } from "../src/server/routes.js";

let directory: string;
let database: DatabaseHandle;
let app: FastifyInstance;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-playlist-client-"));
  database = openDatabase(path.join(directory, "library.sqlite"));
  for (const id of ["first", "second", "third"]) {
    fs.writeFileSync(path.join(directory, `${id}.mp3`), `original-${id}`);
    database.upsertTrack({
      id, path: path.join(directory, `${id}.mp3`), fileName: `${id}.mp3`, title: id,
      album: "测试专辑", artist: "测试艺人", albumArtist: "测试艺人",
      genre: null, year: null, trackNo: 1, discNo: 1, duration: 60, bitrate: 128000,
      codec: "MP3", container: "MPEG", lossless: false, formatGroup: "mp3",
      artworkPath: null, lyricsPath: null, size: 10, mtimeMs: 1
    });
  }
  app = Fastify();
  await registerRoutes(app, {
    database,
    config: {
      port: 0, musicLibraryPath: directory, dataDir: directory, databasePath: path.join(directory, "library.sqlite"),
      artworkDir: path.join(directory, "artwork"), metadataDir: path.join(directory, "metadata"),
      adminPassword: "test", cookieSecret: "test-only-cookie-secret-32-characters",
      enableOnlineMetadata: false, isProduction: false
    },
    scanner: { isRunning: () => false, scan: async () => undefined }
  });
  // Exercise the browser client against the actual routes and SQLite, without opening a port.
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const response = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      url, headers: Object.fromEntries(new Headers(init?.headers)),
      payload: init?.body as string | undefined
    });
    return new Response(response.body, { status: response.statusCode, headers: { "Content-Type": "application/json" } });
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  database.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("playlist browser/server contract", () => {
  it("persists the complete edit lifecycle through client API calls and preserves source tracks", async () => {
    await api.favorite("second", true);
    const playlist = await api.createPlaylist("每日听歌");
    await api.addToPlaylist(playlist.id, "first");
    await api.addToPlaylist(playlist.id, "second");
    let detail = await api.addToPlaylist(playlist.id, "third");
    expect(detail.playlist).toMatchObject({ trackCount: 3, duration: 180 });
    expect(detail.revision).toEqual(expect.any(String));
    const originalRevision = detail.revision;
    await api.renamePlaylist(playlist.id, "  晚间 / 100% 音乐  ");
    detail = await api.playlist(playlist.id);
    expect(detail.playlist.name).toBe("晚间 / 100% 音乐");
    expect(detail.revision).not.toBe(originalRevision);
    detail = await api.reorderPlaylist(playlist.id, ["third", "first", "second"], detail.revision);
    expect(detail.tracks.map((track) => track.id)).toEqual(["third", "first", "second"]);
    const positions = () => (database.db.prepare("SELECT position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position").all(playlist.id) as { position: number }[]).map((row) => row.position);
    expect(positions()).toEqual([1, 2, 3]);
    expect((await api.playlist(playlist.id)).tracks).toEqual(detail.tracks);
    detail = await api.removeFromPlaylist(playlist.id, "first");
    expect(detail.tracks.map((track) => track.id)).toEqual(["third", "second"]);
    expect(detail.playlist.trackCount).toBe(2);
    expect(positions()).toEqual([1, 2]);
    detail = await api.addToPlaylist(playlist.id, "first");
    expect(detail.tracks.map((track) => track.id)).toEqual(["third", "second", "first"]);
    expect(await api.addToPlaylist(playlist.id, "second")).toEqual(detail);
    expect((await api.playlists())[0]).toEqual(detail.playlist);
    await api.deletePlaylist(playlist.id);
    expect(await api.playlists()).toEqual([]);
    await expect(api.playlist(playlist.id)).rejects.toMatchObject({ name: "ApiError", status: 404 });
    expect(database.summary()).toMatchObject({ trackCount: 3, favoriteCount: 1, playlistCount: 0 });
    expect((await api.tracks("?favorite=true")).map((track) => track.id)).toEqual(["second"]);
    expect(database.db.prepare("SELECT * FROM playlist_tracks").all()).toEqual([]);
    for (const id of ["first", "second", "third"]) expect(fs.readFileSync(path.join(directory, `${id}.mp3`), "utf8")).toBe(`original-${id}`);
  });

  it("exposes a conflict status and keeps the newer playlist when an old draft is saved", async () => {
    const playlist = await api.createPlaylist("并发编辑");
    const draft = await api.addToPlaylist(playlist.id, "first");
    await api.addToPlaylist(playlist.id, "second");
    const error = await api.reorderPlaylist(playlist.id, ["first"], draft.revision).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409 });
    expect((await api.playlist(playlist.id)).tracks.map((track) => track.id)).toEqual(["first", "second"]);
  });

  it("lets removal be retried after a lost response without changing the remaining order", async () => {
    const playlist = await api.createPlaylist("重试移除");
    await api.addToPlaylist(playlist.id, "first");
    await api.addToPlaylist(playlist.id, "second");
    const firstResponse = await api.removeFromPlaylist(playlist.id, "first");
    const retryResponse = await api.removeFromPlaylist(playlist.id, "first");
    expect(retryResponse).toEqual(firstResponse);
  });
});
