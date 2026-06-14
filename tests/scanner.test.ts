import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import { openDatabase, type DatabaseHandle } from "../src/server/db.js";
import { createScanner } from "../src/server/scanner.js";

vi.mock("music-metadata", () => ({
  parseFile: vi.fn(async () => {
    throw new Error("Invalid audio metadata");
  })
}));

let dir = "";
let libraryDir = "";
let database: DatabaseHandle;
let warnSpy: ReturnType<typeof vi.spyOn>;

function makeConfig(): AppConfig {
  return {
    port: 0,
    musicLibraryPath: libraryDir,
    dataDir: dir,
    databasePath: path.join(dir, "library.sqlite"),
    artworkDir: path.join(dir, "artwork"),
    metadataDir: path.join(dir, "metadata"),
    adminPassword: "admin",
    cookieSecret: "test-cookie-secret",
    enableOnlineMetadata: false,
    isProduction: false
  };
}

function insertTrack(filePath: string) {
  database.upsertTrack({
    id: "track-1",
    path: filePath,
    fileName: path.basename(filePath),
    title: "Existing Song",
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
    formatGroup: "mp3",
    artworkPath: null,
    lyricsPath: null,
    size: 1024,
    mtimeMs: Date.now()
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "music-scanner-"));
  libraryDir = path.join(dir, "music");
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.mkdirSync(path.join(dir, "artwork"), { recursive: true });
  fs.mkdirSync(path.join(dir, "metadata"), { recursive: true });
  database = openDatabase(path.join(dir, "library.sqlite"));
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  database?.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("scanner pruning safeguards", () => {
  it("reports an empty library path as failed even before any tracks are indexed", async () => {
    await createScanner(makeConfig(), database).scan();

    expect(database.summary().trackCount).toBe(0);
    expect(database.latestScan()).toMatchObject({
      status: "failed",
      totalFiles: 0,
      scannedFiles: 0,
      errorCount: 1,
      message: "扫描未找到音频文件。请确认 MUSIC_LIBRARY_PATH 指向已挂载的 NAS 音乐目录。"
    });
  });

  it("keeps existing tracks when files are present but metadata parsing fails", async () => {
    const trackPath = path.join(libraryDir, "song.mp3");
    fs.writeFileSync(trackPath, "not a real mp3");
    insertTrack(trackPath);

    await createScanner(makeConfig(), database).scan();

    expect(database.summary().trackCount).toBe(1);
    expect(database.listTracks()[0]?.title).toBe("Existing Song");
    expect(database.latestScan()).toMatchObject({
      status: "completed",
      totalFiles: 1,
      scannedFiles: 1,
      errorCount: 1
    });
  });

  it("does not clear the index when a mounted library scan finds no audio files", async () => {
    insertTrack(path.join(libraryDir, "missing.mp3"));

    await createScanner(makeConfig(), database).scan();

    expect(database.summary().trackCount).toBe(1);
    expect(database.latestScan()).toMatchObject({
      status: "failed",
      totalFiles: 0,
      scannedFiles: 0,
      errorCount: 1
    });
  });
});
