import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page, Track } from "../src/shared/types.js";
import { openDatabase, makeAlbumKey, type DatabaseHandle, type UpsertTrack } from "../src/server/db.js";
import { registerRoutes } from "../src/server/routes.js";

let database: DatabaseHandle;
let app: FastifyInstance;

function track(index: number, overrides: Partial<UpsertTrack> = {}): UpsertTrack {
  const suffix = String(index).padStart(4, "0");
  return {
    id: `track-${suffix}`, path: `/test-only/music/${suffix}.mp3`, fileName: `${suffix}.mp3`,
    title: "Library Song", album: `Album ${suffix}`, artist: `Artist ${suffix}`, albumArtist: `Artist ${suffix}`,
    genre: null, year: null, trackNo: 1, discNo: 1, duration: 60, bitrate: 128000,
    codec: "MP3", container: "MPEG", lossless: false, formatGroup: "mp3",
    artworkPath: null, lyricsPath: null, size: 10, mtimeMs: 1, ...overrides
  };
}

beforeEach(async () => {
  database = openDatabase(":memory:");
  database.db.transaction(() => {
    // Reverse insertion order and identical timestamps expose unstable pagination ties.
    for (let index = 242; index >= 0; index--) {
      database.upsertTrack(track(index));
      if (index < 223) database.toggleFavorite(track(index).id, true);
    }
    database.db.prepare("UPDATE tracks SET added_at = '2026-01-01T00:00:00.000Z'").run();
  })();
  app = Fastify();
  await registerRoutes(app, {
    database,
    config: {
      port: 0, musicLibraryPath: "/test-only/music", dataDir: "/test-only/data", databasePath: ":memory:",
      artworkDir: "/test-only/data/artwork", metadataDir: "/test-only/data/metadata",
      adminPassword: "test", cookieSecret: "test-only-cookie-secret-32-characters",
      enableOnlineMetadata: false, isProduction: false
    },
    scanner: { isRunning: () => false, scan: async () => undefined }
  });
});

afterEach(async () => {
  await app.close();
  database.db.close();
});

describe("complete library pagination", () => {
  it.each(["pageTracks", "pageAlbums", "pageArtists"] as const)("keeps %s revisions stable across unchanged pages", (method) => {
    const first = database[method]({ limit: 2, offset: 0 });
    const second = database[method]({ limit: 2, offset: 2 });
    expect(first.revision).toEqual(expect.any(String));
    expect(second.revision).toBe(first.revision);
  });

  it.each(["pageTracks", "pageAlbums", "pageArtists"] as const)("invalidates %s pages after replacement without a total change", (method) => {
    const before = database[method]({ limit: 2 });
    database.removeMissingTracks(new Set(Array.from({ length: 242 }, (_, index) => track(index + 1).path)));
    database.upsertTrack(track(243));
    const after = database[method]({ limit: 2, offset: 2 });
    expect(after.total).toBe(before.total);
    expect(after.revision).not.toBe(before.revision);
  });

  it.each(["pageTracks", "pageAlbums", "pageArtists"] as const)("invalidates %s pages on favorite edits", (method) => {
    const before = database[method]({ limit: 2 });
    database.toggleFavorite("track-0000", false);
    const after = database[method]({ limit: 2, offset: 2 });
    expect(after.total).toBe(before.total);
    expect(after.revision).not.toBe(before.revision);
  });

  it("tracks external writes while keeping a page revision tied to its read snapshot", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-page-revision-"));
    const file = path.join(directory, "library.sqlite");
    const reader = openDatabase(file);
    const writer = new Database(file);
    try {
      reader.upsertTrack(track(0));
      const first = reader.pageTracks();
      let snapshotRevision: string | undefined;
      reader.db.transaction(() => {
        const snapshot = reader.pageTracks();
        snapshotRevision = snapshot.revision;
        writer.prepare("UPDATE tracks SET title = 'External edit' WHERE id = ?").run("track-0000");
        const sameSnapshot = reader.pageTracks();
        expect(sameSnapshot.items[0].title).toBe("Library Song");
        expect(sameSnapshot.revision).toBe(snapshotRevision);
      })();
      const latest = reader.pageTracks();
      expect(snapshotRevision).toBe(first.revision);
      expect(latest.items[0].title).toBe("External edit");
      expect(latest.total).toBe(first.total);
      expect(latest.revision).not.toBe(first.revision);
    } finally {
      writer.close();
      reader.db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("changes revision after reopening the same database", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-page-restart-"));
    const file = path.join(directory, "library.sqlite");
    const first = openDatabase(file);
    let reopened: DatabaseHandle | undefined;
    try {
      first.upsertTrack(track(0));
      const before = first.pageTracks();
      first.db.close();
      reopened = openDatabase(file);
      const after = reopened.pageTracks();
      expect(after.items).toEqual(before.items);
      expect(after.revision).not.toBe(before.revision);
    } finally {
      if (first.db.open) first.db.close();
      reopened?.db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["tracks", 243, "id", ""],
    ["tracks", 223, "id", "&favorite=true"],
    ["albums", 243, "key", ""],
    ["artists", 243, "name", ""]
  ] as const)("paginates all %s entries including the final and empty page (%s)", async (resource, total, identity, filter) => {
    const identities: string[] = [];
    for (let offset = 0; offset < total; offset += 60) {
      const response = await app.inject(`/api/${resource}?page=true&limit=60&offset=${offset}${filter}`);
      expect(response.statusCode).toBe(200);
      const page = response.json<Page<Record<string, string>>>();
      expect(page).toMatchObject({ total, limit: 60, offset });
      expect(page.items).toHaveLength(Math.min(60, total - offset));
      identities.push(...page.items.map((item) => item[identity]));
    }
    expect(identities).toHaveLength(total);
    expect(new Set(identities).size).toBe(total);
    expect(identities).toEqual([...identities].sort());
    for (const offset of [total, total + 50]) {
      const response = await app.inject(`/api/${resource}?page=true&limit=60&offset=${offset}${filter}`);
      expect(response.json()).toEqual({ items: [], total, limit: 60, offset, revision: expect.any(String) });
    }
  });

  it.each(["tracks", "albums", "artists"])("preserves array responses for %s while honoring pagination", async (resource) => {
    const expected = (await app.inject(`/api/${resource}?page=true&limit=7&offset=210`)).json().items;
    for (const suffix of ["", "&page=false"]) {
      const response = await app.inject(`/api/${resource}?limit=7&offset=210${suffix}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected);
    }
  });

  it("preserves legacy default limits and reports accurate page defaults", async () => {
    expect(database.listTracks()).toHaveLength(80);
    expect(database.listAlbums()).toHaveLength(200);
    expect(database.listArtists()).toHaveLength(200);
    for (const [resource, limit] of [["tracks", 80], ["albums", 200], ["artists", 200]] as const) {
      const response = await app.inject(`/api/${resource}?page=true`);
      expect(response.json()).toMatchObject({ total: 243, offset: 0, limit });
      expect(response.json().items).toHaveLength(limit);
    }
  });

  it("counts filtered tracks and favorites independently of page size", async () => {
    database.upsertTrack(track(240, { title: "Distinctive needle" }));
    database.upsertTrack(track(2, { title: "Distinctive needle" }));
    const all = (await app.inject("/api/tracks?page=true&q=Distinctive&limit=1")).json<Page<Track>>();
    expect(all.total).toBe(2);
    expect(all.items).toHaveLength(1);
    const favorites = (await app.inject("/api/tracks?page=true&q=Distinctive&favorite=true&limit=1")).json<Page<Track>>();
    expect(favorites.total).toBe(1);
    expect(favorites.items.map((item) => item.id)).toEqual(["track-0002"]);
    expect((await app.inject("/api/tracks?page=true&q=Distinctive&favorite=true&offset=1")).json().items).toEqual([]);
  });

  it("breaks tied track metadata and search rank with the unique track id", () => {
    for (const index of [402, 401, 400]) {
      database.upsertTrack(track(index, { title: "Tie", album: "Tied Album", artist: "Tie Artist", albumArtist: "Tie Artist" }));
    }
    const expected = ["track-0400", "track-0401", "track-0402"];
    expect(database.listTracks({ offset: 243, limit: 3 }).map((item) => item.id)).toEqual(expected);
    expect([0, 1, 2].map((offset) => database.pageTracks({ q: "Tie", limit: 1, offset }).items[0].id)).toEqual(expected);
    expect(database.getAlbum("tied album::tie artist")?.tracks.map((item) => item.id)).toEqual(expected);
    expect(database.getArtist("Tie Artist")?.tracks.map((item) => item.id)).toEqual(expected);
  });

  it("includes albums in artist details for case variants and unknown artists", () => {
    database.upsertTrack(track(400, { album: "Mixed Case", artist: "Case Artist", albumArtist: "Case Artist" }));
    database.upsertTrack(track(401, { album: "Mixed Case", artist: "case artist", albumArtist: "case artist" }));
    database.upsertTrack(track(402, { album: null, artist: null, albumArtist: null }));
    for (const name of ["Case Artist", "case artist", "未知艺人"]) {
      const detail = database.getArtist(name);
      expect(detail?.tracks).toHaveLength(1);
      expect(detail?.albums).toHaveLength(1);
      expect(detail?.albums[0].key).toBe(detail?.tracks[0].albumKey);
    }
  });

  it.each(["albums", "artists"])("filters the full %s library before paginating", async (resource) => {
    const query = resource === "albums" ? "Album 02" : "Artist 02";
    const page = (await app.inject(`/api/${resource}?page=true&q=${encodeURIComponent(query)}&limit=7&offset=40`)).json<Page<unknown>>();
    expect(page).toMatchObject({ total: 43, limit: 7, offset: 40 });
    expect(page.items).toHaveLength(3);
  });

  it.each(["100%", "_", "夜曲", "éTé", "/", "Zz Special"])("keeps album and artist substring search literal and case-insensitive: %s", async (q) => {
    database.upsertTrack(track(242, {
      album: "ZZ Special 100%_ÉTÉ 夜曲 /", artist: "ZZ Special 100%_ÉTÉ 夜曲 /", albumArtist: "ZZ Special 100%_ÉTÉ 夜曲 /"
    }));
    for (const resource of ["albums", "artists"]) {
      const response = await app.inject(`/api/${resource}?page=true&q=${encodeURIComponent(q)}&limit=1`);
      expect(response.statusCode).toBe(200);
      expect(response.json().total).toBe(1);
      expect(response.json().items).toHaveLength(1);
    }
    const preview = (await app.inject(`/api/search?q=${encodeURIComponent(q)}`)).json();
    expect(preview.albums).toHaveLength(1);
    expect(preview.artists).toHaveLength(1);
  });

  it.each(["tracks", "albums", "artists"])("returns zero matches for a missing %s query", async (resource) => {
    const response = await app.inject(`/api/${resource}?page=true&q=NoSuchEntry&limit=50&offset=300`);
    expect(response.json()).toEqual({ items: [], total: 0, limit: 50, offset: 300, revision: expect.any(String) });
  });

  it("preserves punctuation-only and whitespace track search behavior in pages", () => {
    expect(database.pageTracks({ q: "***" })).toEqual({ items: [], total: 0, limit: 80, offset: 0, revision: expect.any(String) });
    expect(database.pageTracks({ q: "   ", favorite: true }).total).toBe(223);
  });

  it.each(["tracks", "albums", "artists"])("rejects invalid %s page parameters", async (resource) => {
    for (const query of ["limit=0", "limit=-1", "limit=501", "limit=1.5", "limit=nope", "limit=Infinity",
      "offset=-1", "offset=1.5", "offset=9007199254740992", "offset=Infinity", "page=yes", "q=" + "x".repeat(513)]) {
      const response = await app.inject(`/api/${resource}?${query}`);
      expect(response.statusCode, query).toBe(400);
      expect(response.json()).toEqual({ error: "请求参数不正确，请检查后重试" });
    }
  });

  it("includes usable album keys with the same SQLite ASCII folding rules", async () => {
    const entry = track(242, { album: "ÉTÉ / 夜曲", albumArtist: "MÜNCHEN", artist: "Performer" });
    database.upsertTrack(entry);
    const song = (await app.inject(`/api/tracks/${entry.id}`)).json<Track>();
    expect(song.albumKey).toBe("ÉtÉ / 夜曲::mÜnchen");
    expect(song.albumKey).toBe(makeAlbumKey(entry.album, entry.albumArtist, entry.artist));
    const detail = await app.inject(`/api/albums/${encodeURIComponent(song.albumKey!)}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().tracks.map((item: Track) => item.id)).toEqual([entry.id]);
  });

  it("opens album and artist details beyond 10,000 groups without truncation", async () => {
    // Only in-memory metadata is needed here; no real media or user database is accessed.
    database.db.exec(`
      WITH RECURSIVE entries(i) AS (VALUES(0) UNION ALL SELECT i + 1 FROM entries WHERE i < 10005)
      INSERT INTO tracks (id, path, file_name, title, album, artist, album_artist, format_group, size, mtime_ms, added_at, updated_at)
      SELECT printf('deep-%05d', i), printf('/test-only/deep/%05d.mp3', i), 'deep.mp3', 'Deep Song',
        printf('ZZ Deep Album %05d', i), printf('ZZ Deep Artist %05d', i), printf('ZZ Deep Artist %05d', i),
        'mp3', 10, 1, '2025-01-01', '2025-01-01' FROM entries;
    `);
    const album = await app.inject(`/api/albums/${encodeURIComponent("zz deep album 10005::zz deep artist 10005")}`);
    const artist = await app.inject(`/api/artists/${encodeURIComponent("ZZ Deep Artist 10005")}`);
    expect(album.statusCode).toBe(200);
    expect(album.json().tracks.map((item: Track) => item.id)).toEqual(["deep-10005"]);
    expect(artist.statusCode).toBe(200);
    expect(artist.json().tracks.map((item: Track) => item.id)).toEqual(["deep-10005"]);
    expect(artist.json().albums.map((item: { key: string }) => item.key)).toEqual(["zz deep album 10005::zz deep artist 10005"]);
  });
});
