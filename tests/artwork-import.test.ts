import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importAlbumArtwork, main } from "../src/server/artwork-import.js";
import { openDatabase } from "../src/server/db.js";
import { acquireDataLock } from "../src/server/data-lock.js";

let directory: string;
let dataDir: string;
let imagePath: string;
let albumKey: string;
const sourceUrl = "https://example.com/official-cover";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const options = () => ({ dataDir, imagePath, albumKey, sourceUrl });
const readDatabase = () => openDatabase(path.join(dataDir, "music-library.sqlite"));

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-artwork-import-"));
  dataDir = path.join(directory, "data");
  fs.mkdirSync(path.join(dataDir, "artwork"), { recursive: true });
  imagePath = path.join(directory, "cover.png");
  fs.writeFileSync(imagePath, png);
  const database = readDatabase();
  for (const id of ["one", "two", "existing", "other"]) database.upsertTrack({
    id, path: `/music/Album/${id}.flac`, fileName: `${id}.flac`, title: id,
    album: id === "other" ? "Other" : "Album", albumArtist: null, artist: "Artist", genre: null, year: null,
    discNo: 1, trackNo: 1, duration: 60, bitrate: null, codec: "FLAC", container: "FLAC", lossless: true,
    formatGroup: "flac", artworkPath: id === "existing" ? path.join(dataDir, "artwork", "original.png") : null,
    lyricsPath: null, size: 100, mtimeMs: 1
  });
  fs.writeFileSync(path.join(dataDir, "artwork", "original.png"), png);
  database.toggleFavorite("one", true);
  database.addTrackToPlaylist(database.createPlaylist("Saved").id, "two");
  albumKey = database.getTrack("one")!.albumKey!;
  database.db.close();
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("offline album artwork import", () => {
  it("fills only missing covers on the selected album, records provenance and leaves user data and tags intact", () => {
    let database = readDatabase();
    const snapshot = () => [
      database.db.prepare("SELECT id,path,album,album_artist,disc_no,favorite,updated_at FROM tracks ORDER BY id").all(),
      database.db.prepare("SELECT * FROM tracks_fts ORDER BY id").all(),
      database.db.prepare("SELECT * FROM playlist_tracks").all()
    ];
    const before = snapshot();
    database.db.close();
    const result = importAlbumArtwork(options());
    expect(result.updatedTracks).toBe(2);
    expect(fs.readFileSync(result.artworkPath!)).toEqual(png);
    database = readDatabase();
    expect(database.getIndexedTrack("/music/Album/one.flac")?.artworkPath).toBe(result.artworkPath);
    expect(database.getIndexedTrack("/music/Album/two.flac")?.artworkPath).toBe(result.artworkPath);
    expect(database.getIndexedTrack("/music/Album/existing.flac")?.artworkPath).toBe(path.join(dataDir, "artwork", "original.png"));
    expect(database.getTrack("other")?.hasArtwork).toBe(false);
    expect(database.getMetadataCache(`album-artwork:${albumKey}`)).toMatchObject({ sourceUrl, artworkPath: result.artworkPath });
    expect(snapshot()).toEqual(before);
    database.db.close();
    expect(importAlbumArtwork(options()).updatedTracks).toBe(0);
  });

  it("refuses a live service data lock and can retry after shutdown", () => {
    const lock = acquireDataLock(dataDir);
    try { expect(() => importAlbumArtwork(options())).toThrow("请先停止服务"); }
    finally { lock.release(); }
    expect(importAlbumArtwork(options()).updatedTracks).toBe(2);
  });

  it("does not write artwork for an unknown album", () => {
    expect(() => importAlbumArtwork({ ...options(), albumKey: "unknown" })).toThrow("找不到唯一匹配");
    expect(fs.readdirSync(path.join(dataDir, "artwork"))).toEqual(["original.png"]);
  });

  it("rejects a cache directory pointing outside DATA_DIR", () => {
    fs.rmSync(path.join(dataDir, "artwork"), { recursive: true });
    const outside = path.join(directory, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dataDir, "artwork"));
    expect(() => importAlbumArtwork(options())).toThrow("Path escapes configured root");
    expect(fs.readdirSync(outside)).toEqual([]);
    const database = readDatabase();
    expect(database.getTrack("one")?.hasArtwork).toBe(false);
    database.db.close();
  });

  it.each(["invalid image", "invalid source", "symlink image"])("rejects %s before changing the cache", (kind) => {
    const input = options();
    if (kind === "invalid image") fs.writeFileSync(imagePath, "not an image");
    if (kind === "invalid source") input.sourceUrl = "file:///secret";
    if (kind === "symlink image") { input.imagePath = path.join(directory, "link.png"); fs.symlinkSync(imagePath, input.imagePath); }
    expect(() => importAlbumArtwork(input)).toThrow();
    expect(fs.readdirSync(path.join(dataDir, "artwork"))).toEqual(["original.png"]);
  });

  it("requires explicit CLI parameters and does not create an empty database", () => {
    const output = { log: () => {}, error: () => {} };
    expect(main([], {}, output)).toBe(1);
    expect(main(["--help"], {}, output)).toBe(0);
    expect(() => importAlbumArtwork({ ...options(), dataDir: path.join(directory, "empty") })).toThrow();
    expect(fs.existsSync(path.join(directory, "empty", "music-library.sqlite"))).toBe(false);
  });
});
