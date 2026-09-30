import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseHandle, type UpsertTrack } from "../src/server/db.js";
import { createAlbumEnricher } from "../src/server/album-enrichment.js";
import type { AppConfig } from "../src/server/config.js";
import type { ScanEvent, Scanner } from "../src/server/scanner.js";
import type { Album, AlbumMetadataCandidate, AlbumMetadataLookup } from "../src/shared/types.js";
import { backupData, restoreData } from "../src/server/maintenance.js";

let root: string, library: string, database: DatabaseHandle, config: AppConfig;
let worker: ReturnType<typeof createAlbumEnricher>;
let running: boolean, listener: ((event: ScanEvent) => void) | undefined;
let scanner: Scanner;
const releaseId = "06594de4-cb73-4b2d-a27c-bdfae5235b17";
function track(id = "one", changes: Partial<UpsertTrack> = {}): UpsertTrack {
  return { id, path: path.join(library, `${id}.flac`), fileName: `${id}.flac`, title: id, album: "Album", albumArtist: "Artist", artist: "Artist", year: null, genre: null, trackNo: 1, discNo: 1, duration: 60, bitrate: 800000, codec: "FLAC", container: "FLAC", lossless: true, formatGroup: "flac", artworkPath: null, lyricsPath: null, size: 1, mtimeMs: 1, ...changes };
}
function result(album = database.listAlbums()[0], changes: Partial<AlbumMetadataLookup> = {}): AlbumMetadataLookup {
  return { recommendedId: releaseId, partial: false, truncated: false, candidates: [{
    id: releaseId, title: album.title, artist: album.artist!, year: 2018, genre: "原声", date: "2018-12-14", country: "JP", format: "Digital Media", trackCount: album.trackCount, discCount: 1,
    sourceUrl: `https://musicbrainz.org/release/${releaseId}`, official: true, artistCompatible: true, matches: { artist: true, tracks: true, discs: true, year: true }
  }], ...changes };
}
const current = () => database.getAlbumMetadata(database.listAlbums()[0].key)!;
function makeWorker(lookup = vi.fn<(album: Album) => Promise<AlbumMetadataLookup>>(async (album) => result(album))) {
  worker = createAlbumEnricher(config, database, scanner, lookup);
  return lookup;
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "album-enrichment-")));
  library = path.join(root, "music"); fs.mkdirSync(library);
  fs.mkdirSync(path.join(root, "data"));
  database = openDatabase(path.join(root, "data/music-library.sqlite")); database.setLibraryRoot(library);
  database.upsertTrack(track());
  config = { enableOnlineMetadata: true, autoCompleteAlbumMetadata: true } as AppConfig;
  running = false; listener = undefined;
  scanner = { isRunning: () => running, scan: async () => {}, subscribe(callback) { listener = callback; return () => { listener = undefined; }; } };
});
afterEach(() => { worker?.stop(); if (database.db.open) database.db.close(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });

describe("background album enrichment", () => {
  it("saves a unique reliable match with provenance and updates catalog revisions without changing music, source tags or private data", async () => {
    fs.writeFileSync(track().path, "audio is read-only");
    database.toggleFavorite("one", true);
    const playlist = database.createPlaylist("保留"); database.addTrackToPlaylist(playlist.id, "one");
    const before = database.db.prepare("SELECT * FROM tracks").all();
    const revision = database.catalogRevision(); const playlistRevision = database.getPlaylist(playlist.id)!.revision;
    const lookup = makeWorker(); worker.trigger(); await worker.whenIdle();
    expect(lookup).toHaveBeenCalledOnce();
    expect(current()).toMatchObject({ album: { year: 2018, genre: "原声" }, original: { year: null, genre: null }, overrides: { year: null, genre: null }, automatic: { year: 2018, genre: "原声", sourceUrl: `https://musicbrainz.org/release/${releaseId}`, matchedAt: expect.any(String) } });
    expect(database.getTrack("one")).toMatchObject({ year: 2018, genre: "原声", favorite: true });
    expect(database.forUser("listener").getTrack("one")).toMatchObject({ year: 2018, genre: "原声", favorite: false });
    expect(database.search("原声").albums).toHaveLength(1);
    expect(database.catalogRevision()).not.toBe(revision);
    expect(database.getPlaylist(playlist.id)!.revision).toBe(playlistRevision);
    expect(database.db.prepare("SELECT * FROM tracks").all()).toEqual(before);
    expect(fs.readFileSync(track().path, "utf8")).toBe("audio is read-only");
    expect(worker.status()).toMatchObject({ state: "completed", checked: 1, updated: 1, failed: 0 });
    worker.trigger(); await worker.whenIdle(); expect(lookup).toHaveBeenCalledOnce();
  });
  it.each([{ truncated: true }, { partial: true }, { candidates: [] }])("does not commit an uncertain or incomplete result: %j", async (change) => {
    makeWorker(vi.fn(async () => result(undefined, change))); worker.trigger(); await worker.whenIdle();
    expect(current().album).toMatchObject({ year: null, genre: null });
    expect(current().automatic).toBeNull();
  });
  it("rejects conflicting artists or track counts even if a cached result supplies a recommendation", async () => {
    const match = result(); match.candidates[0].matches.tracks = false;
    makeWorker(vi.fn(async () => match)); worker.trigger(); await worker.whenIdle();
    expect(current().automatic).toBeNull();
  });
  it("only fills missing fields and lets newer native tags take priority after a scan", async () => {
    database.upsertTrack(track("one", { year: 2018 }));
    makeWorker(); worker.trigger(); await worker.whenIdle();
    expect(current().automatic).toMatchObject({ year: null, genre: "原声" });
    database.upsertTrack(track("one", { year: 2023, genre: "Game Soundtrack" }));
    expect(current().album).toMatchObject({ year: 2023, genre: "Game Soundtrack" });
  });
  it("retains explicit edits and an empty restore across scans and restarts", async () => {
    const lookup = makeWorker(); worker.trigger(); await worker.whenIdle();
    database.saveAlbumMetadata(current().album.key, { year: null, genre: null }, current().revision);
    expect(current()).toMatchObject({ autoFillBlocked: true, automatic: null, album: { year: null, genre: null } });
    expect(database.db.prepare("SELECT * FROM album_metadata_overrides").all()).toEqual([]);
    worker.stop(); database.db.close(); database = openDatabase(path.join(root, "data/music-library.sqlite")); database.setLibraryRoot(library);
    makeWorker(lookup); worker.trigger(); await worker.whenIdle(); expect(lookup).toHaveBeenCalledOnce();
    expect(current().autoFillBlocked).toBe(true);
  });
  it("does not replace edits made while a remote query is in flight", async () => {
    makeWorker(vi.fn(async () => {
      database.saveAlbumMetadata(current().album.key, { year: 2025, genre: "自定流派" }, current().revision);
      return result();
    }));
    worker.trigger(); await worker.whenIdle();
    expect(current()).toMatchObject({ album: { year: 2025, genre: "自定流派" }, automatic: null });
  });
  it("rejects old results when the track set or selected directory changes", async () => {
    makeWorker(vi.fn(async () => { database.upsertTrack(track("two")); return result(); }));
    worker.trigger(); await worker.whenIdle(); expect(current().automatic).toBeNull(); worker.stop();
    makeWorker(vi.fn(async () => {
      database.upsertTrack(track("other", { path: path.join(root, "other/other.flac") }));
      database.setLibraryRoot(path.join(root, "other")); return result();
    }));
    worker.trigger(); await worker.whenIdle(); expect(current().automatic).toBeNull();
    database.setLibraryRoot(library); expect(current().automatic).toBeNull();
  });
  it("cancels old queries on scan start, ignores partial scans, and starts a fresh pass only after a complete scan", async () => {
    let release!: (value: AlbumMetadataLookup) => void;
    const lookup = makeWorker(vi.fn(() => new Promise<AlbumMetadataLookup>((resolve) => { release = resolve; })));
    worker.trigger(); await Promise.resolve();
    running = true; listener!({ type: "started" });
    release(result()); await worker.whenIdle(); expect(current().automatic).toBeNull();
    running = false; listener!({ type: "finished", complete: false }); await worker.whenIdle(); expect(lookup).toHaveBeenCalledOnce();
    lookup.mockImplementation(async () => result());
    listener!({ type: "finished", complete: true }); await worker.whenIdle(); expect(current().album.year).toBe(2018);
  });
  it("queues a completed new scan while an old lookup is still pending", async () => {
    let release!: (value: AlbumMetadataLookup) => void;
    const lookup = makeWorker(vi.fn(() => new Promise<AlbumMetadataLookup>((resolve) => { release = resolve; })));
    worker.trigger(); await Promise.resolve();
    running = true; listener!({ type: "started" }); running = false; listener!({ type: "finished", complete: true });
    lookup.mockImplementation(async () => result()); release(result()); await worker.whenIdle();
    expect(lookup).toHaveBeenCalledTimes(2); expect(worker.status().updated).toBe(1);
  });
  it("does not write after shutdown, even if an old request resolves after the database closes", async () => {
    let release!: (value: AlbumMetadataLookup) => void;
    makeWorker(vi.fn(() => new Promise<AlbumMetadataLookup>((resolve) => { release = resolve; })));
    worker.trigger(); await Promise.resolve(); const response = result(); worker.stop(); database.db.close();
    release(response); await expect(worker.whenIdle()).resolves.toBeUndefined(); expect(listener).toBeUndefined();
  });
  it.each([{ enableOnlineMetadata: false }, { autoCompleteAlbumMetadata: false }])("does not schedule any lookups when disabled: %j", async (settings) => {
    Object.assign(config, settings); const lookup = makeWorker(); worker.trigger(); await worker.whenIdle();
    expect(lookup).not.toHaveBeenCalled(); expect(listener).toBeUndefined(); expect(worker.status().enabled).toBe(false);
  });
  it("catches up an existing complete scan on startup but skips retained missing indexes", async () => {
    const job = database.createScanJob(); database.updateScanJob(job.id, { status: "completed", totalFiles: 0, scannedFiles: 0, errorCount: 0 });
    const lookup = makeWorker(); worker.start(); await worker.whenIdle(); expect(lookup).not.toHaveBeenCalled();
    database.updateScanJob(job.id, { totalFiles: 1, scannedFiles: 1 });
    worker.start(); await worker.whenIdle(); expect(lookup).toHaveBeenCalledOnce();
  });
  it("continues beyond the first 200 albums", async () => {
    for (let index = 0; index < 205; index++) database.upsertTrack(track(String(index), { album: `Album ${index}`, year: 2018, genre: "原声" }));
    const lookup = makeWorker(); worker.trigger(); await worker.whenIdle();
    expect(worker.status()).toMatchObject({ checked: 206, updated: 1, skipped: 205 }); expect(lookup).toHaveBeenCalledOnce();
  });
  it("backs off after provider failures and retries without an unbounded request loop", async () => {
    vi.useFakeTimers();
    for (let index = 0; index < 5; index++) database.upsertTrack(track(String(index), { album: `Other ${index}` }));
    const lookup = makeWorker(vi.fn(async () => { throw new Error("offline"); }));
    worker.trigger(); await worker.whenIdle(); expect(lookup).toHaveBeenCalledTimes(3); expect(worker.status().state).toBe("waiting");
    await vi.advanceTimersByTimeAsync(60_000); await worker.whenIdle(); expect(lookup).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(300_000); await worker.whenIdle(); expect(lookup).toHaveBeenCalledTimes(9);
    expect(worker.status().state).toBe("completed"); await vi.advanceTimersByTimeAsync(600_000); expect(lookup).toHaveBeenCalledTimes(9);
  });
  it("includes source attribution and manual protection in verified backups", async () => {
    makeWorker(); worker.trigger(); await worker.whenIdle(); worker.stop(); database.db.close();
    const backup = await backupData({ dataDir: path.join(root, "data"), backupRoot: path.join(root, "backups"), musicLibraryPath: library });
    await restoreData({ backupDir: backup, dataDir: path.join(root, "restored") });
    database = openDatabase(path.join(root, "restored/music-library.sqlite")); database.setLibraryRoot(library);
    expect(current()).toMatchObject({ album: { year: 2018, genre: "原声" }, automatic: { sourceUrl: `https://musicbrainz.org/release/${releaseId}` } });
  });
});
