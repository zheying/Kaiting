import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Playlist, PlaylistDetail } from "../src/shared/types.js";
import { openDatabase, type DatabaseHandle } from "../src/server/db.js";
import { registerRoutes } from "../src/server/routes.js";

let directory: string;
let database: DatabaseHandle;
let app: FastifyInstance;
const ids = ["track-1", "track-2", "track-3"];

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-playlists-"));
  database = openDatabase(path.join(directory, "library.sqlite"));
  for (const id of ids) {
    const filePath = path.join(directory, `${id}.mp3`);
    fs.writeFileSync(filePath, `original-${id}`);
    database.upsertTrack({
      id, path: filePath, fileName: `${id}.mp3`, title: id, album: "Album", artist: "Artist", albumArtist: "Artist",
      genre: null, year: null, trackNo: 1, discNo: 1, duration: 60, bitrate: 128000, codec: "MP3", container: "MPEG",
      lossless: false, formatGroup: "mp3", artworkPath: null, lyricsPath: null, size: 10, mtimeMs: 1
    });
  }
  database.toggleFavorite(ids[0], true);
  app = Fastify();
  await registerRoutes(app, {
    database,
    config: {
      port: 0, musicLibraryPath: directory, dataDir: directory, databasePath: path.join(directory, "library.sqlite"),
      artworkDir: path.join(directory, "artwork"), metadataDir: path.join(directory, "metadata"),
      adminPassword: "test", cookieSecret: "test-only-cookie-secret-32-characters", enableOnlineMetadata: false, isProduction: false
    },
    scanner: { isRunning: () => false, scan: async () => undefined }
  });
});

afterEach(async () => {
  await app.close();
  database.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function createPlaylist(trackIds = ids): Promise<PlaylistDetail> {
  const response = await app.inject({ method: "POST", url: "/api/playlists", payload: { name: "  日常听歌  ", description: "测试歌单" } });
  expect(response.statusCode).toBe(200);
  const playlist = response.json<Playlist>();
  for (const trackId of trackIds) {
    const added = await app.inject({ method: "POST", url: `/api/playlists/${playlist.id}/tracks`, payload: { trackId } });
    expect(added.statusCode).toBe(200);
    expect(added.json().revision).toEqual(expect.any(String));
  }
  return (await app.inject(`/api/playlists/${playlist.id}`)).json<PlaylistDetail>();
}

function positions(playlistId: string): number[] {
  return (database.db.prepare("SELECT position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, track_id")
    .all(playlistId) as { position: number }[]).map((row) => row.position);
}

describe("playlist management", () => {
  it("preserves a description supplied by an API client when renaming", async () => {
    const original = await createPlaylist();
    const response = await app.inject({ method: "PATCH", url: `/api/playlists/${original.playlist.id}`, payload: { name: "夜间播放" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: "夜间播放", description: "测试歌单" });
  });

  it("persists names, member order, and revision across reopening the database", async () => {
    const detail = await createPlaylist();
    database.renamePlaylist(detail.playlist.id, "持久化歌单");
    const renamed = database.getPlaylist(detail.playlist.id)!;
    const saved = database.reorderPlaylistTracks(detail.playlist.id, [...ids].reverse(), renamed.revision);
    expect(saved.status).toBe("ok");
    const expected = database.getPlaylist(detail.playlist.id);
    database.db.close();
    database = openDatabase(path.join(directory, "library.sqlite"));
    expect(database.getPlaylist(detail.playlist.id)).toEqual(expected);
    expect(database.getTrack(ids[0])?.favorite).toBe(true);
  });

  it("deletes only the requested playlist and its memberships", async () => {
    const removed = await createPlaylist();
    const retained = await createPlaylist([ids[0], ids[2]]);
    expect((await app.inject({ method: "DELETE", url: `/api/playlists/${removed.playlist.id}` })).statusCode).toBe(200);
    expect(database.getPlaylist(retained.playlist.id)).toEqual(retained);
    expect(database.listPlaylists().map((playlist) => playlist.id)).toEqual([retained.playlist.id]);
    expect(database.summary()).toMatchObject({ trackCount: 3, favoriteCount: 1, playlistCount: 1 });
  });

  it("detects content changes from another database connection", async () => {
    const detail = await createPlaylist();
    const other = openDatabase(path.join(directory, "library.sqlite"));
    try {
      other.db.prepare("UPDATE playlists SET description = ? WHERE id = ?").run("另一连接更新了描述", detail.playlist.id);
      const changed = database.getPlaylist(detail.playlist.id)!;
      expect(changed.revision).not.toBe(detail.revision);
      expect(database.reorderPlaylistTracks(detail.playlist.id, [...ids].reverse(), detail.revision)).toEqual({ status: "conflict" });
      expect(other.reorderPlaylistTracks(detail.playlist.id, [...ids].reverse(), changed.revision).status).toBe("ok");
      expect(database.reorderPlaylistTracks(detail.playlist.id, ids, changed.revision)).toEqual({ status: "conflict" });
    } finally {
      other.db.close();
    }
  });

  it.each([
    { trackIds: [ids[0], ids[0], ids[2]], status: 400 },
    { trackIds: [ids[0], ids[1]], status: 409 },
    { trackIds: [ids[0], ids[1], "unknown"], status: 409 },
    { trackIds: [...ids, "unknown"], status: 409 },
    { trackIds: [], status: 409 }
  ])("rejects an invalid permutation without partially changing members: $trackIds", async ({ trackIds, status }) => {
    const detail = await createPlaylist();
    const response = await app.inject({ method: "PUT", url: `/api/playlists/${detail.playlist.id}/tracks/order`,
      payload: { trackIds, revision: detail.revision } });
    expect(response.statusCode).toBe(status);
    expect(database.getPlaylist(detail.playlist.id)).toEqual(detail);
    expect(positions(detail.playlist.id)).toEqual([1, 2, 3]);
  });

  it.each([null, 1, "track-1", [1, ids[1], ids[2]], [null, ids[1], ids[2]], [[ids[0]], ids[1], ids[2]], [{ id: ids[0] }, ids[1], ids[2]]])
    ("rejects invalid nested track IDs before coercion: %j", async (trackIds) => {
      const detail = await createPlaylist();
      const response = await app.inject({ method: "PUT", url: `/api/playlists/${detail.playlist.id}/tracks/order`,
        payload: { trackIds, revision: detail.revision } });
      expect(response.statusCode).toBe(400);
      expect(database.getPlaylist(detail.playlist.id)).toEqual(detail);
    });

  it.each([undefined, null, 1, true, "", ["revision"]])("rejects an invalid revision: %j", async (revision) => {
    const detail = await createPlaylist();
    const response = await app.inject({ method: "PUT", url: `/api/playlists/${detail.playlist.id}/tracks/order`, payload: { trackIds: ids, revision } });
    expect(response.statusCode).toBe(400);
    expect(database.getPlaylist(detail.playlist.id)).toEqual(detail);
  });

  it("rejects a competing reorder of the same members even with identical timestamps", async () => {
    const detail = await createPlaylist();
    const url = `/api/playlists/${detail.playlist.id}/tracks/order`;
    const responses = await Promise.all([
      app.inject({ method: "PUT", url, payload: { trackIds: [...ids].reverse(), revision: detail.revision } }),
      app.inject({ method: "PUT", url, payload: { trackIds: [ids[1], ids[2], ids[0]], revision: detail.revision } })
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = responses.find((response) => response.statusCode === 200)!.json<PlaylistDetail>();
    database.db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(detail.playlist.updatedAt, detail.playlist.id);
    const stale = await app.inject({ method: "PUT", url, payload: { trackIds: ids, revision: detail.revision } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "歌单已发生变化，请刷新后重新排序" });
    expect(database.getPlaylist(detail.playlist.id)?.tracks).toEqual(winner.tracks);
  });

  it("detects member replacement with the same count and a stale rename", async () => {
    const detail = await createPlaylist([ids[0], ids[1]]);
    database.removeTrackFromPlaylist(detail.playlist.id, ids[0]);
    database.addTrackToPlaylist(detail.playlist.id, ids[2]);
    const url = `/api/playlists/${detail.playlist.id}/tracks/order`;
    expect((await app.inject({ method: "PUT", url, payload: { trackIds: [ids[2], ids[1]], revision: detail.revision } })).statusCode).toBe(409);
    const current = database.getPlaylist(detail.playlist.id)!;
    database.renamePlaylist(detail.playlist.id, "新名称");
    expect((await app.inject({ method: "PUT", url, payload: { trackIds: [ids[2], ids[1]], revision: current.revision } })).statusCode).toBe(409);
    expect(database.getPlaylist(detail.playlist.id)?.tracks.map((track) => track.id)).toEqual([ids[1], ids[2]]);
  });

  it("keeps revision local to playlist content, and idempotent operations preserve it", async () => {
    const detail = await createPlaylist();
    const other = await createPlaylist([ids[1]]);
    database.renamePlaylist(other.playlist.id, "其他歌单");
    database.addTrackToPlaylist(other.playlist.id, ids[2]);
    database.toggleFavorite(ids[0], false);
    expect(database.getPlaylist(detail.playlist.id)?.revision).toBe(detail.revision);
    database.renamePlaylist(detail.playlist.id, detail.playlist.name);
    const duplicate = database.addTrackToPlaylist(detail.playlist.id, ids[0]);
    const removed = await app.inject({ method: "DELETE", url: `/api/playlists/${detail.playlist.id}/tracks/not-a-member` });
    const reordered = database.reorderPlaylistTracks(detail.playlist.id, ids, detail.revision);
    expect(duplicate?.revision).toBe(detail.revision);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ ok: true, revision: detail.revision });
    expect(reordered).toMatchObject({ status: "ok", detail: { revision: detail.revision } });
  });

  it("accepts an empty permutation for an empty playlist", async () => {
    const detail = await createPlaylist([]);
    const response = await app.inject({ method: "PUT", url: `/api/playlists/${detail.playlist.id}/tracks/order`,
      payload: { trackIds: [], revision: detail.revision } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(detail);
  });

  it("uses a deterministic tie order and compacts legacy gaps on the next member mutation", async () => {
    const detail = await createPlaylist();
    database.db.prepare("UPDATE playlist_tracks SET position = 100 WHERE playlist_id = ?").run(detail.playlist.id);
    expect(database.getPlaylist(detail.playlist.id)?.tracks.map((track) => track.id)).toEqual(ids);
    database.removeTrackFromPlaylist(detail.playlist.id, ids[1]);
    expect(positions(detail.playlist.id)).toEqual([1, 2]);
    database.addTrackToPlaylist(detail.playlist.id, ids[1]);
    expect(positions(detail.playlist.id)).toEqual([1, 2, 3]);
    expect(database.getPlaylist(detail.playlist.id)?.tracks.map((track) => track.id)).toEqual([ids[0], ids[2], ids[1]]);
  });

  it.each([null, 42, false, {}, ["name"], "", "  \n\t  ", "x".repeat(201)])("rejects invalid rename values: %j", async (name) => {
    const detail = await createPlaylist();
    const response = await app.inject({ method: "PATCH", url: `/api/playlists/${detail.playlist.id}`, payload: { name } });
    expect(response.statusCode).toBe(400);
    expect(database.getPlaylist(detail.playlist.id)).toEqual(detail);
  });

  it("validates the trimmed name length", async () => {
    const detail = await createPlaylist();
    const response = await app.inject({ method: "PATCH", url: `/api/playlists/${detail.playlist.id}`, payload: { name: `  ${"曲".repeat(200)}  ` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe("曲".repeat(200));
  });

  it("returns 404 for mutations on an unknown playlist and for adding an unknown track", async () => {
    const responses = await Promise.all([
      app.inject({ method: "PATCH", url: "/api/playlists/missing", payload: { name: "Missing" } }),
      app.inject({ method: "DELETE", url: "/api/playlists/missing" }),
      app.inject({ method: "POST", url: "/api/playlists/missing/tracks", payload: { trackId: ids[0] } }),
      app.inject({ method: "DELETE", url: `/api/playlists/missing/tracks/${ids[0]}` }),
      app.inject({ method: "PUT", url: "/api/playlists/missing/tracks/order", payload: { trackIds: [], revision: "missing" } })
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404]);
    for (const response of responses) expect(response.json()).toEqual({ error: "未找到资源" });
    const detail = await createPlaylist();
    expect((await app.inject({ method: "POST", url: `/api/playlists/${detail.playlist.id}/tracks`, payload: { trackId: "missing" } })).statusCode).toBe(404);
    expect(database.getPlaylist(detail.playlist.id)).toEqual(detail);
  });
});
