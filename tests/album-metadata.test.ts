import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle, type UpsertTrack } from "../src/server/db.js";
import { backupData, restoreData } from "../src/server/maintenance.js";

let root: string, library: string, file: string, database: DatabaseHandle;
function track(id = "one", directory = library): UpsertTrack {
  return { id, path: path.join(directory, `${id}.flac`), fileName: `${id}.flac`, title: `歌曲 ${id}`, album: "Album", artist: "Artist", albumArtist: "Artist", genre: null, year: null, trackNo: 1, discNo: 1, duration: 60, bitrate: 800000, codec: "FLAC", container: "FLAC", lossless: true, formatGroup: "flac", artworkPath: null, lyricsPath: null, size: 1, mtimeMs: 1 };
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "album-metadata-")));
  library = path.join(root, "music"); fs.mkdirSync(library);
  file = path.join(root, "data/music-library.sqlite");
  fs.mkdirSync(path.dirname(file));
  database = openDatabase(file); database.setLibraryRoot(library);
  database.upsertTrack(track()); database.upsertTrack(track("two"));
});
afterEach(() => { if (database?.db.open) database.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
function edit(year: number | null = 2018, genre: string | null = "游戏原声") {
  const key = database.listAlbums()[0].key;
  return database.saveAlbumMetadata(key, { year, genre }, database.getAlbumMetadata(key)!.revision);
}

describe("read-only library album metadata overlays", () => {
  it("updates every catalog surface without touching source tags, IDs, favorites, or playlist order", () => {
    database.toggleFavorite("one", true);
    const playlist = database.createPlaylist("保留顺序");
    database.addTrackToPlaylist(playlist.id, "two"); database.addTrackToPlaylist(playlist.id, "one");
    const raw = database.db.prepare("SELECT * FROM tracks ORDER BY id").all();
    const revision = database.pageTracks().revision;
    const playlistRevision = database.getPlaylist(playlist.id)!.revision;
    const key = database.listAlbums()[0].key;
    expect(edit()).toMatchObject({ status: "ok", metadata: { album: { key, year: 2018, genre: "游戏原声" }, original: { year: null, genre: null } } });
    expect(database.db.prepare("SELECT * FROM tracks ORDER BY id").all()).toEqual(raw);
    expect(database.getIndexedTrack(track().path)).toMatchObject({ year: null, genre: null });
    expect(database.getTrack("one")).toMatchObject({ year: 2018, genre: "游戏原声", favorite: true });
    expect(database.forUser("listener").getTrack("one")).toMatchObject({ year: 2018, genre: "游戏原声", favorite: false });
    expect(database.getAlbum(key)?.tracks.every((item) => item.year === 2018)).toBe(true);
    expect(database.getArtist("Artist")?.albums[0]).toMatchObject({ year: 2018, genre: "游戏原声" });
    expect(database.search("游戏原声").albums.map((album) => album.key)).toEqual([key]);
    expect(database.pageTracks({ q: "游戏原声", favorite: true }).items.map((song) => song.id)).toEqual(["one"]);
    expect(database.getPlaylist(playlist.id)?.tracks.map((song) => song.id)).toEqual(["two", "one"]);
    expect(database.getPlaylist(playlist.id)?.revision).toBe(playlistRevision);
    expect(database.pageTracks().revision).not.toBe(revision);
  });
  it("survives re-indexing and restarts, and restores the newest source values", () => {
    edit();
    database.upsertTrack({ ...track(), year: 2023, genre: "Soundtrack" });
    database.upsertTrack({ ...track("two"), year: 2023, genre: "Soundtrack" });
    database.db.close(); database = openDatabase(file); database.setLibraryRoot(library);
    const key = database.listAlbums()[0].key;
    expect(database.getAlbumMetadata(key)).toMatchObject({ original: { year: 2023, genre: "Soundtrack" }, overrides: { year: 2018, genre: "游戏原声" }, album: { year: 2018, genre: "游戏原声" } });
    expect(edit(null, null)).toMatchObject({ status: "ok", metadata: { album: { year: 2023, genre: "Soundtrack" }, overrides: { year: null, genre: null } } });
    expect(database.db.prepare("SELECT * FROM album_metadata_overrides").all()).toEqual([]);
  });
  it("keeps overrides scoped to the selected library and prevents stale edits", () => {
    const key = database.listAlbums()[0].key;
    const initial = database.getAlbumMetadata(key)!;
    edit();
    expect(database.saveAlbumMetadata(key, { year: 2019, genre: null }, initial.revision).status).toBe("conflict");
    const otherRoot = path.join(root, "other");
    database.upsertTrack(track("other", otherRoot)); database.setLibraryRoot(otherRoot);
    expect(database.getAlbumMetadata(key)).toMatchObject({ album: { year: null, genre: null } });
    expect(database.saveAlbumMetadata(key, { year: 2019, genre: null }, initial.revision).status).toBe("conflict");
    expect(database.saveAlbumMetadata("nonexistent", { year: null, genre: null }, initial.revision).status).toBe("not_found");
    database.setLibraryRoot(library); expect(database.getAlbum(key)?.album.year).toBe(2018);
  });
  it("does not freeze unchanged source fields when only one field is supplemented", () => {
    database.upsertTrack({ ...track(), year: 2023 }); database.upsertTrack({ ...track("two"), year: 2023 });
    expect(edit(2023, " 游戏原声 ")).toMatchObject({ status: "ok", metadata: { overrides: { year: null, genre: "游戏原声" } } });
    database.upsertTrack({ ...track(), year: 2024 }); database.upsertTrack({ ...track("two"), year: 2024 });
    expect(database.listAlbums()[0].year).toBe(2024);
  });
  it("includes manual information in verified data backups and restores", async () => {
    edit(); database.db.close();
    const backup = await backupData({ dataDir: path.dirname(file), backupRoot: path.join(root, "backups"), musicLibraryPath: library });
    const restored = path.join(root, "restored");
    await restoreData({ backupDir: backup, dataDir: restored });
    database = openDatabase(path.join(restored, "music-library.sqlite")); database.setLibraryRoot(library);
    expect(database.listAlbums()[0]).toMatchObject({ year: 2018, genre: "游戏原声" });
  });
});
