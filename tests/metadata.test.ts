import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseHandle, type UpsertTrack } from "../src/server/db.js";
import { enrichTrackMetadata, lookupLyrics, musicBrainzQuery, parseMusicBrainz } from "../src/server/metadata.js";
import type { AppConfig } from "../src/server/config.js";

let dir = "";
let database: DatabaseHandle;
let config: AppConfig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "music-metadata-"));
  database = openDatabase(path.join(dir, "library.sqlite"));
  config = {
    port: 3000,
    musicLibraryPath: path.join(dir, "music"),
    dataDir: dir,
    databasePath: path.join(dir, "library.sqlite"),
    artworkDir: path.join(dir, "artwork"),
    metadataDir: path.join(dir, "metadata"),
    adminPassword: "admin",
    cookieSecret: "secret",
    enableOnlineMetadata: true,
    isProduction: false
  };
  fs.mkdirSync(config.musicLibraryPath, { recursive: true });
  fs.mkdirSync(config.artworkDir, { recursive: true });
  fs.mkdirSync(config.metadataDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  database?.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function track(overrides: Partial<UpsertTrack> = {}): UpsertTrack {
  return {
    id: "track-1",
    path: path.join(config.musicLibraryPath, "track.m4a"),
    fileName: "track.m4a",
    title: "Song",
    album: null,
    artist: "Artist",
    albumArtist: null,
    genre: null,
    year: null,
    trackNo: null,
    discNo: null,
    duration: 181,
    bitrate: 256000,
    codec: "AAC",
    container: "MPEG-4",
    lossless: false,
    formatGroup: "m4a",
    artworkPath: path.join(config.artworkDir, "existing.jpg"),
    lyricsPath: path.join(config.metadataDir, "existing.lrc"),
    size: 1024,
    mtimeMs: Date.now(),
    ...overrides
  };
}

describe("online metadata", () => {
  it("keeps scan enrichment local when only on-demand lookups are enabled", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const local = track({ year: null, artworkPath: null, lyricsPath: null });
    expect(await enrichTrackMetadata({ ...config, scanOnlineMetadata: false }, database, local, fetcher)).toEqual(local);
    expect(fetcher).not.toHaveBeenCalled();
    expect(database.metadataCacheCount()).toBe(0);
  });
  it("builds safe MusicBrainz queries", () => {
    expect(musicBrainzQuery({ title: "A \"Song\"", artist: "Artist", album: "Album" }))
      .toBe('recording:"A Song" AND artist:"Artist" AND release:"Album"');
  });

  it("parses MusicBrainz recording data", () => {
    const parsed = parseMusicBrainz({
      recordings: [{
        title: "Song",
        "artist-credit": [{ artist: { name: "Artist" } }],
        releases: [{
          id: "release-1",
          title: "Album",
          date: "2024-05-01",
          "artist-credit": [{ artist: { name: "Album Artist" } }]
        }]
      }]
    });

    expect(parsed).toMatchObject({
      album: "Album",
      artist: "Artist",
      albumArtist: "Album Artist",
      year: 2024,
      releaseId: "release-1"
    });
  });

  it("fills missing tags from cached online metadata without replacing local values", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      recordings: [{
        title: "Online Song",
        "artist-credit": [{ artist: { name: "Online Artist" } }],
        releases: [{ id: "release-1", title: "Online Album", date: "2024" }]
      }]
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const enriched = await enrichTrackMetadata(config, database, track({ album: null, year: null }), fetcher as typeof fetch);
    expect(enriched.title).toBe("Song");
    expect(enriched.artist).toBe("Artist");
    expect(enriched.album).toBe("Online Album");
    expect(enriched.year).toBe(2024);
    expect(database.metadataCacheCount()).toBe(1);

    await enrichTrackMetadata(config, database, track({ album: null, year: null }), fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("looks up LRCLIB lyrics, stores them under DATA_DIR, and reuses the cache", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      trackName: "Song", artistName: "Artist", duration: 181,
      syncedLyrics: "[00:01.00]第一句\n[00:03.50]第二句",
      plainLyrics: null
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const lyricsPath = await lookupLyrics(config, track({ lyricsPath: null }), database, fetcher as typeof fetch);

    expect(lyricsPath).toContain(path.join(config.metadataDir, "lyrics"));
    expect(fs.readFileSync(String(lyricsPath), "utf8")).toContain("第一句");
    expect(fetcher).toHaveBeenCalledTimes(1);

    const cachedPath = await lookupLyrics(config, track({ lyricsPath: null }), database, fetcher as typeof fetch);
    expect(cachedPath).toBe(lyricsPath);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses broad title searches when provider artist names differ from local tags", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const requestUrl = new URL(url);
      if (requestUrl.pathname === "/api/search" && requestUrl.searchParams.get("q") === "no rhyme nor reason") {
        return new Response(JSON.stringify([
          {
            trackName: "no rhyme nor reason",
            artistName: "トゲナシトゲアリ",
            albumName: "Togeari",
            duration: 191,
            syncedLyrics: "[00:01.00]淀んでいる 歪んでいる",
            plainLyrics: null
          }
        ]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestUrl.pathname === "/api/search") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    });

    const lyricsPath = await lookupLyrics(
      config,
      track({ title: "no rhyme nor reason", artist: "TOGENASHITOGEARI", album: "Togeari", duration: 191, lyricsPath: null }),
      database,
      fetcher as typeof fetch
    );

    expect(fs.readFileSync(String(lyricsPath), "utf8")).toContain("淀んでいる");
    expect(fetcher.mock.calls.some(([url]) => {
      const requestUrl = new URL(String(url));
      return requestUrl.pathname === "/api/search" && requestUrl.searchParams.get("q") === "no rhyme nor reason";
    })).toBe(true);
  });

  it("falls back to broad LRCLIB q searches when structured search misses", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const requestUrl = new URL(url);
      if (requestUrl.pathname === "/api/search" && requestUrl.searchParams.get("q") === "Song Artist") {
        return new Response(JSON.stringify([
          {
            trackName: "Song",
            artistName: "Artist",
            albumName: "Album",
            duration: 181,
            syncedLyrics: "[00:01.00]fallback broad search",
            plainLyrics: null
          }
        ]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestUrl.pathname === "/api/search") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    });

    const lyricsPath = await lookupLyrics(
      config,
      track({ album: "Album", lyricsPath: null }),
      database,
      fetcher as typeof fetch
    );

    expect(fs.readFileSync(String(lyricsPath), "utf8")).toContain("fallback broad search");
    expect(fetcher.mock.calls.some(([url]) => new URL(String(url)).searchParams.get("q") === "Song Artist")).toBe(true);
  });

  it("prefers synced LRCLIB lyrics over original-script plain lyrics", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const requestUrl = new URL(url);
      if (requestUrl.pathname === "/api/get" && requestUrl.searchParams.get("artist_name") === "TOGENASHITOGEARI") {
        return new Response(JSON.stringify({
          trackName: "Nameless Name",
          artistName: "Togenashi Togeari",
          albumName: "Togeari",
          duration: 189,
          syncedLyrics: "[00:01.00]Itsu datte kizu bakka",
          plainLyrics: null
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestUrl.pathname === "/api/search" && requestUrl.searchParams.get("artist_name") === "TOGENASHITOGEARI") {
        return new Response(JSON.stringify([
          {
            trackName: "Nameless Name",
            artistName: "Togenashi Togeari",
            albumName: "Togeari",
            duration: 189,
            syncedLyrics: "[00:01.00]Itsu datte kizu bakka",
            plainLyrics: null
          },
          {
            trackName: "Nameless Name",
            artistName: "TOGENASHI TOGEARI",
            albumName: "Nameless Name",
            duration: 188,
            syncedLyrics: null,
            plainLyrics: "いつだって傷ばっか"
          }
        ]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    });

    const lyricsPath = await lookupLyrics(
      config,
      track({ title: "Nameless Name", artist: "TOGENASHITOGEARI", album: "Togeari", duration: 189, lyricsPath: null }),
      database,
      fetcher as typeof fetch
    );

    expect(fs.readFileSync(String(lyricsPath), "utf8")).toContain("[00:01.00]Itsu datte kizu bakka");
  });

  it("prefers original-script lyrics among synced LRCLIB candidates", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const requestUrl = new URL(url);
      if (requestUrl.pathname === "/api/get" && requestUrl.searchParams.get("artist_name") === "TOGENASHITOGEARI") {
        return new Response(JSON.stringify({
          trackName: "Nameless Name",
          artistName: "Togenashi Togeari",
          albumName: "Togeari",
          duration: 189,
          syncedLyrics: "[00:01.00]Itsu datte kizu bakka",
          plainLyrics: null
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestUrl.pathname === "/api/search" && requestUrl.searchParams.get("artist_name") === "TOGENASHITOGEARI") {
        return new Response(JSON.stringify([
          {
            trackName: "Nameless Name",
            artistName: "Togenashi Togeari",
            albumName: "Togeari",
            duration: 189,
            syncedLyrics: "[00:01.00]Itsu datte kizu bakka",
            plainLyrics: null
          },
          {
            trackName: "Nameless Name",
            artistName: "TOGENASHI TOGEARI",
            albumName: "棘アリ",
            duration: 189,
            syncedLyrics: "[00:01.00]いつだって傷ばっか",
            plainLyrics: null
          }
        ]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    });

    const lyricsPath = await lookupLyrics(
      config,
      track({ title: "Nameless Name", artist: "TOGENASHITOGEARI", album: "Togeari", duration: 189, lyricsPath: null }),
      database,
      fetcher as typeof fetch
    );

    expect(fs.readFileSync(String(lyricsPath), "utf8")).toContain("[00:01.00]いつだって傷ばっか");
  });

  it("caches missing LRCLIB lyrics", async () => {
    const fetcher = vi.fn(async (input: string) => new URL(input).pathname.endsWith("/search")
      ? Response.json([]) : new Response(null, { status: 404 }));

    const lyricsPath = await lookupLyrics(config, track({ lyricsPath: null }), database, fetcher as typeof fetch);
    const callsAfterFirstLookup = fetcher.mock.calls.length;
    const cachedPath = await lookupLyrics(config, track({ lyricsPath: null }), database, fetcher as typeof fetch);

    expect(lyricsPath).toBeNull();
    expect(cachedPath).toBeNull();
    expect(callsAfterFirstLookup).toBeGreaterThan(2);
    expect(fetcher).toHaveBeenCalledTimes(callsAfterFirstLookup);
  });

  it("expires LRCLIB misses and repairs missing cache files", async () => {
    const local = track({ lyricsPath: null });
    let available = false;
    const fetcher = vi.fn(async (input: string) => available
      ? Response.json({ trackName: "Song", artistName: "Artist", duration: 181, syncedLyrics: "[00:01.00]缓存修复测试" })
      : new URL(input).pathname.endsWith("/search") ? Response.json([]) : new Response(null, { status: 404 }));
    expect(await lookupLyrics(config, local, database, fetcher as typeof fetch)).toBeNull();
    const before = fetcher.mock.calls.length;
    available = true;
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60 * 1000);
    const result = await lookupLyrics(config, local, database, fetcher as typeof fetch);
    expect(result).toBeTruthy(); expect(fetcher.mock.calls.length).toBeGreaterThan(before);
    fs.unlinkSync(result!);
    expect(fs.readFileSync((await lookupLyrics(config, local, database, fetcher as typeof fetch))!, "utf8")).toContain("缓存修复测试");
  });

  it.each(["network", "server", "invalid"])("does not cache LRCLIB %s failures as missing lyrics", async (failure) => {
    const fetcher = vi.fn(async () => {
      if (failure === "network") throw new Error("fixture offline");
      return failure === "server" ? new Response(null, { status: 503 }) : Response.json({ unexpected: true });
    });
    await expect(lookupLyrics(config, track(), database, fetcher as typeof fetch)).rejects.toThrow();
    expect(database.metadataCacheCount()).toBe(0);
  });

  it("honors LRCLIB rate-limit cooldown even for an explicit retry", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 429, headers: { "Retry-After": "60" } }));
    await expect(lookupLyrics(config, track(), database, fetcher as typeof fetch)).rejects.toThrow();
    await expect(lookupLyrics(config, track(), database, fetcher as typeof fetch)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(database.metadataCacheCount()).toBe(0);
  });

  it("rejects unrelated or wrong-duration LRCLIB results before preferring synced lyrics", async () => {
    const fetcher = vi.fn(async (input: string) => new URL(input).pathname.endsWith("/search") ? Response.json([
      { trackName: "Completely Different", artistName: "Artist", albumName: "Album", duration: 181, syncedLyrics: "[00:01.00]错误歌曲" },
      { trackName: "Song", artistName: "Artist", duration: 70, syncedLyrics: "[00:01.00]错误版本" },
      { trackName: "Song", artistName: "Unrelated", duration: 181, syncedLyrics: "[00:01.00]同名异曲" },
      { trackName: "Song", artistName: "Artist", duration: 181, plainLyrics: "Correct fixture lyrics" }
    ]) : new Response(null, { status: 404 }));
    const result = await lookupLyrics(config, track({ album: "Album" }), database, fetcher as typeof fetch);
    expect(JSON.parse(fs.readFileSync(result!, "utf8")).text).toBe("Correct fixture lyrics");
  });

  it("coalesces concurrent LRCLIB lookups for the same track", async () => {
    const fetcher = vi.fn(async () => Response.json({ trackName: "Song", artistName: "Artist", duration: 181,
      syncedLyrics: "[00:01.00]并发查询测试" }));
    const results = await Promise.all([lookupLyrics(config, track(), database, fetcher as typeof fetch), lookupLyrics(config, track(), database, fetcher as typeof fetch)]);
    expect(results[0]).toBe(results[1]); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps an exact LRCLIB match if an optional follow-up search fails", async () => {
    const fetcher = vi.fn(async (input: string) => new URL(input).pathname.endsWith("/get")
      ? Response.json({ trackName: "Song", artistName: "Artist", duration: 181, syncedLyrics: "[00:01.00]Fixture lyric" })
      : new Response(null, { status: 503 }));
    const result = await lookupLyrics(config, track(), database, fetcher as typeof fetch);
    expect(JSON.parse(fs.readFileSync(result!, "utf8")).text).toBe("[00:01.00]Fixture lyric");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not request online lyrics when online metadata is disabled", async () => {
    const fetcher = vi.fn();

    const enriched = await enrichTrackMetadata(
      { ...config, enableOnlineMetadata: false },
      database,
      track({ lyricsPath: null }),
      fetcher as typeof fetch
    );

    expect(enriched.lyricsPath).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
