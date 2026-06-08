import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/server/db.js";

let dir = "";
let database: DatabaseHandle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "music-db-"));
  database = openDatabase(path.join(dir, "library.sqlite"));
});

afterEach(() => {
  database?.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function insertTrack(id: string, title: string, favorite = false) {
  database.upsertTrack({
    id,
    path: path.join(dir, `${id}.m4a`),
    fileName: `${id}.m4a`,
    title,
    album: "Album",
    artist: "Artist",
    albumArtist: "Artist",
    genre: "Pop",
    year: 2024,
    trackNo: 1,
    discNo: 1,
    duration: 180,
    bitrate: 256000,
    codec: "AAC",
    container: "MPEG-4",
    lossless: false,
    formatGroup: "m4a",
    artworkPath: null,
    lyricsPath: null,
    size: 1024,
    mtimeMs: Date.now()
  });
  if (favorite) database.toggleFavorite(id, true);
}

describe("database", () => {
  it("indexes tracks, albums, artists and search", () => {
    insertTrack("track-1", "First Song");
    expect(database.summary().trackCount).toBe(1);
    expect(database.listAlbums()).toHaveLength(1);
    expect(database.listArtists()).toHaveLength(1);
    expect(database.search("First").tracks[0]?.title).toBe("First Song");
  });

  it("stores playlists and favorites", () => {
    insertTrack("track-1", "First Song", true);
    const playlist = database.createPlaylist("晚间播放");
    database.addTrackToPlaylist(playlist.id, "track-1");
    expect(database.listTracks({ favorite: true })).toHaveLength(1);
    expect(database.getPlaylist(playlist.id)?.tracks[0]?.id).toBe("track-1");
  });

  it("stores scan errors and metadata cache entries", () => {
    const job = database.createScanJob();
    database.recordScanError(job.id, "/music/broken.flac", "Invalid data");
    database.setMetadataCache("musicbrainz:test", "MusicBrainz", { album: "Album" });

    expect(database.listScanErrors(job.id)).toMatchObject([
      { scanId: job.id, path: "/music/broken.flac", message: "Invalid data" }
    ]);
    expect(database.getMetadataCache("musicbrainz:test")).toEqual({ album: "Album" });
    expect(database.metadataCacheCount()).toBe(1);
  });
});
