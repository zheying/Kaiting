import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertInsideRoot, safeRealPath } from "../src/server/pathSafety.js";
import { openDatabase } from "../src/server/db.js";
import { createScanner } from "../src/server/scanner.js";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "music-root-"));
  fs.writeFileSync(path.join(root, "song.mp3"), "");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("path safety", () => {
  it("allows paths inside the configured root", () => {
    expect(assertInsideRoot(root, path.join(root, "song.mp3"))).toBe(path.join(root, "song.mp3"));
    expect(safeRealPath(root, path.join(root, "song.mp3"))).toBe(fs.realpathSync.native(path.join(root, "song.mp3")));
  });

  it("rejects traversal outside the configured root", () => {
    expect(() => assertInsideRoot(root, path.join(root, "..", "outside.mp3"))).toThrow(/escapes/);
  });

  it("accepts both alias and canonical paths under a symlinked library root", () => {
    const library = path.join(root, "library");
    const alias = path.join(root, "nas-music");
    fs.mkdirSync(library);
    fs.writeFileSync(path.join(library, "song.mp3"), "audio");
    fs.symlinkSync(library, alias, "dir");
    const canonicalTrack = fs.realpathSync.native(path.join(library, "song.mp3"));

    expect(safeRealPath(alias, path.join(alias, "song.mp3"))).toBe(canonicalTrack);
    expect(safeRealPath(alias, canonicalTrack)).toBe(canonicalTrack);
  });

  it("rejects external symlink targets and sibling paths for alias and canonical roots", () => {
    const library = path.join(root, "library");
    const alias = path.join(root, "nas-music");
    const outside = path.join(root, "song.mp3");
    fs.mkdirSync(library);
    fs.symlinkSync(library, alias, "dir");
    fs.symlinkSync(outside, path.join(library, "external.mp3"));
    const canonicalLibrary = fs.realpathSync.native(library);

    for (const configuredRoot of [alias, canonicalLibrary]) {
      expect(() => safeRealPath(configuredRoot, outside)).toThrow(/escapes/);
      expect(() => safeRealPath(configuredRoot, path.join(alias, "..", "song.mp3"))).toThrow(/escapes/);
      expect(() => safeRealPath(configuredRoot, path.join(canonicalLibrary, "external.mp3"))).toThrow(/escapes/);
    }
    expect(() => safeRealPath(alias, path.join(alias, "external.mp3"))).toThrow(/escapes/);
    expect(() => safeRealPath(alias, path.join(root, "library-extra", "song.mp3"))).toThrow(/escapes/);
  });

  it("allows real filenames beginning with two dots", () => {
    const filePath = path.join(root, "..song.mp3");
    fs.writeFileSync(filePath, "audio");
    expect(safeRealPath(root, filePath)).toBe(fs.realpathSync.native(filePath));
  });

  it("reads a scanner-generated canonical track path through a configured root symlink", async () => {
    const library = path.join(root, "library");
    const alias = path.join(root, "nas-music");
    const dataDir = path.join(root, "data");
    const artworkDir = path.join(dataDir, "artwork");
    const metadataDir = path.join(dataDir, "metadata");
    fs.mkdirSync(library);
    fs.mkdirSync(artworkDir, { recursive: true });
    fs.mkdirSync(metadataDir, { recursive: true });
    fs.symlinkSync(library, alias, "dir");

    // A tiny valid PCM WAV avoids both external fixtures and an FFmpeg dependency.
    const audio = Buffer.alloc(44 + 160);
    audio.write("RIFF", 0);
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.write("WAVEfmt ", 8);
    audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(8000, 24);
    audio.writeUInt32LE(16000, 28);
    audio.writeUInt16LE(2, 32);
    audio.writeUInt16LE(16, 34);
    audio.write("data", 36);
    audio.writeUInt32LE(160, 40);
    const filePath = path.join(library, "song.wav");
    fs.writeFileSync(filePath, audio);
    const databasePath = path.join(dataDir, "library.sqlite");
    const database = openDatabase(databasePath);
    try {
      await createScanner({
        port: 0, musicLibraryPath: alias, dataDir, databasePath, artworkDir, metadataDir,
        adminPassword: "admin", cookieSecret: "test-secret", enableOnlineMetadata: false, isProduction: false
      }, database).scan();
      expect(database.latestScan()).toMatchObject({ status: "completed", scannedFiles: 1, errorCount: 0 });
      const tracks = database.listTracks();
      expect(tracks).toHaveLength(1);
      expect(tracks[0].path).toBe(fs.realpathSync.native(filePath));
      expect(fs.readFileSync(safeRealPath(alias, tracks[0].path))).toEqual(audio);
    } finally {
      database.db.close();
    }
  });
});
