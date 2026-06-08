import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseHandle, type UpsertTrack } from "../src/server/db.js";
import { enrichTrackMetadata, musicBrainzQuery, parseMusicBrainz } from "../src/server/metadata.js";
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
});
