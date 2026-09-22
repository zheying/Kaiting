import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/server/db.js";
import { acquireDataLock, DATA_LOCK_FILE, RESTORE_MARKER_FILE } from "../src/server/data-lock.js";
import { backupData, main, restoreData, type BackupManifest } from "../src/server/maintenance.js";

let directory: string;
let dataDir: string;
let musicDir: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-maintenance-"));
  dataDir = path.join(directory, "data");
  musicDir = path.join(directory, "music");
  fs.mkdirSync(path.join(dataDir, "artwork"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "metadata", "lyrics"), { recursive: true });
  fs.mkdirSync(musicDir);
  fs.writeFileSync(path.join(dataDir, "artwork", "cover.jpg"), "cached artwork");
  fs.writeFileSync(path.join(dataDir, "metadata", "lyrics", "track.lrc"), "[00:01.00]缓存歌词");
  fs.writeFileSync(path.join(dataDir, ".env"), "PRIVATE=do-not-copy");
  fs.writeFileSync(path.join(dataDir, "metadata", ".env.production"), "PRIVATE=also-do-not-copy");
  fs.writeFileSync(path.join(musicDir, "song.mp3"), "original music bytes");
  fs.writeFileSync(path.join(musicDir, "cover.jpg"), "original sidecar artwork");
  fs.writeFileSync(path.join(musicDir, "song.lrc"), "original sidecar lyrics");
  const database = openDatabase(path.join(dataDir, "music-library.sqlite"));
  try {
    for (const index of [1, 2]) {
      database.upsertTrack({
        id: `track-${index}`, path: path.join(musicDir, `song${index === 1 ? "" : "2"}.mp3`), fileName: `song${index}.mp3`, title: `Song ${index}`,
        album: "Album", artist: "Artist", albumArtist: "Artist", genre: null, year: null, trackNo: index, discNo: 1,
        duration: 60, bitrate: 128000, codec: "MP3", container: "MPEG", lossless: false, formatGroup: "mp3",
        artworkPath: index === 1 ? path.join(dataDir, "artwork", "cover.jpg") : path.join(musicDir, "cover.jpg"),
        lyricsPath: index === 1 ? path.join(dataDir, "metadata", "lyrics", "track.lrc") : path.join(musicDir, "song.lrc"),
        size: 10, mtimeMs: 1
      });
    }
    database.toggleFavorite("track-1", true);
    const playlist = database.createPlaylist("每天听", "保留歌单描述");
    database.addTrackToPlaylist(playlist.id, "track-2");
    database.addTrackToPlaylist(playlist.id, "track-1");
    database.setMetadataCache("cover", "Cover Art Archive", { artworkPath: path.join(dataDir, "artwork", "cover.jpg") });
    database.setMetadataCache("lyrics", "LRCLIB", { lyricsPath: path.join(dataDir, "metadata", "lyrics", "track.lrc") });
    database.setMetadataCache("nested", "test", { values: [{ artworkPath: path.join(fs.realpathSync(dataDir), "artwork", "cover.jpg") }], outside: `${dataDir}-sibling/artwork/file.jpg`, music: path.join(musicDir, "cover.jpg") });
    const scan = database.createScanJob();
    database.updateScanJob(scan.id, { status: "completed", totalFiles: 2, scannedFiles: 2 });
    database.recordScanError(scan.id, path.join(musicDir, "missing.mp3"), "示例错误");
  } finally {
    database.db.close();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

function backup() { return backupData({ dataDir, musicLibraryPath: musicDir }); }
function manifest(backupDir: string): BackupManifest { return JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8")); }
function saveManifest(backupDir: string, value: unknown) { fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify(value)); }
function target(name = "restored") { return path.join(directory, name); }
function updateFileHash(backupDir: string, relative: string) {
  const value = manifest(backupDir);
  const bytes = fs.readFileSync(path.join(backupDir, relative));
  Object.assign(value.files.find((file) => file.path === relative)!, { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  saveManifest(backupDir, value);
}

describe("offline data backup and restore", () => {
  it("backs up only the database and cache files into a completed checksummed directory", async () => {
    const result = await backup();
    expect(path.dirname(result)).toBe(path.join(fs.realpathSync(dataDir), "backups"));
    expect(path.basename(result)).toMatch(/^backup-/);
    const value = manifest(result);
    expect(value).toMatchObject({ version: 1, source: { dataDir, realDataDir: fs.realpathSync(dataDir), musicLibraryPath: musicDir } });
    expect(value.files.map((file) => file.path)).toEqual(["artwork/cover.jpg", "metadata/lyrics/track.lrc", "music-library.sqlite"]);
    for (const file of value.files) {
      const bytes = fs.readFileSync(path.join(result, file.path));
      expect(bytes.length).toBe(file.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
    expect(fs.readdirSync(path.dirname(result))).toEqual([path.basename(result)]);
    expect(fs.existsSync(path.join(result, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(result, DATA_LOCK_FILE))).toBe(false);
    expect(fs.readFileSync(path.join(musicDir, "song.mp3"), "utf8")).toBe("original music bytes");
    expect(await backup()).not.toBe(result);
  });

  it("restores all user state and relocates cache paths without changing music paths or track IDs", async () => {
    const result = await backup();
    const original = new Database(path.join(result, "music-library.sqlite"), { readonly: true });
    const originalTracks = original.prepare("SELECT id, path FROM tracks ORDER BY id").all();
    original.close();
    const restored = await restoreData({ backupDir: result, dataDir: target() });
    const database = openDatabase(path.join(restored, "music-library.sqlite"));
    try {
      expect(database.summary()).toMatchObject({ trackCount: 2, favoriteCount: 1, playlistCount: 1 });
      const playlist = database.listPlaylists()[0];
      expect(playlist).toMatchObject({ name: "每天听", description: "保留歌单描述" });
      expect(database.getPlaylist(playlist.id)?.tracks.map((track) => track.id)).toEqual(["track-2", "track-1"]);
      expect(database.db.prepare("SELECT id, path FROM tracks ORDER BY id").all()).toEqual(originalTracks);
      expect(database.getTrackLyricsPath("track-1")).toBe(path.join(restored, "metadata", "lyrics", "track.lrc"));
      expect(database.getTrackLyricsPath("track-2")).toBe(path.join(musicDir, "song.lrc"));
      expect(database.getMetadataCache("cover")).toEqual({ artworkPath: path.join(restored, "artwork", "cover.jpg") });
      expect(database.getMetadataCache("lyrics")).toEqual({ lyricsPath: path.join(restored, "metadata", "lyrics", "track.lrc") });
      expect(database.getMetadataCache("nested")).toEqual({ values: [{ artworkPath: path.join(restored, "artwork", "cover.jpg") }], outside: `${dataDir}-sibling/artwork/file.jpg`, music: path.join(musicDir, "cover.jpg") });
      expect(database.latestScan()?.status).toBe("completed");
      expect(database.listScanErrors()).toHaveLength(1);
      expect(database.db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      database.db.close();
    }
    expect(fs.readFileSync(path.join(restored, "artwork", "cover.jpg"), "utf8")).toBe("cached artwork");
    expect(fs.readFileSync(path.join(restored, "metadata", "lyrics", "track.lrc"), "utf8")).toContain("缓存歌词");
    expect(fs.existsSync(path.join(restored, RESTORE_MARKER_FILE))).toBe(false);
    const lock = acquireDataLock(restored);
    lock.release();
  });

  it("accepts an existing empty target with a released runtime lock", async () => {
    const result = await backup();
    const lock = acquireDataLock(target());
    lock.release();
    const inode = fs.statSync(path.join(target(), DATA_LOCK_FILE)).ino;
    await restoreData({ backupDir: result, dataDir: target() });
    expect(fs.statSync(path.join(target(), DATA_LOCK_FILE)).ino).toBe(inode);
  });

  it("refuses backup or restore while the same DATA_DIR is in use", async () => {
    const sourceLock = acquireDataLock(dataDir);
    try { await expect(backup()).rejects.toThrow("请先停止服务"); } finally { sourceLock.release(); }
    const result = await backup();
    const destinationLock = acquireDataLock(target());
    try { await expect(restoreData({ backupDir: result, dataDir: target() })).rejects.toThrow("请先停止服务"); } finally { destinationLock.release(); }
  });

  it("never overwrites any existing data in a restore target", async () => {
    const result = await backup();
    fs.mkdirSync(target());
    fs.writeFileSync(path.join(target(), "keep.txt"), "untouched");
    await expect(restoreData({ backupDir: result, dataDir: target() })).rejects.toThrow("不会覆盖已有数据");
    expect(fs.readFileSync(path.join(target(), "keep.txt"), "utf8")).toBe("untouched");
    const before = fs.readFileSync(path.join(dataDir, "music-library.sqlite"));
    await expect(restoreData({ backupDir: result, dataDir })).rejects.toThrow("不会覆盖已有数据");
    expect(fs.readFileSync(path.join(dataDir, "music-library.sqlite"))).toEqual(before);
  });

  it.each(["music-library.sqlite", "artwork/cover.jpg", "metadata/lyrics/track.lrc"])("rejects a modified backup file before publishing: %s", async (file) => {
    const result = await backup();
    fs.appendFileSync(path.join(result, file), "tampered");
    await expect(restoreData({ backupDir: result, dataDir: target() })).rejects.toThrow("校验失败");
    expect(fs.readdirSync(target())).toEqual([DATA_LOCK_FILE]);
  });

  it("checks SQLite integrity even when the manifest matches the corrupted bytes", async () => {
    const result = await backup();
    fs.writeFileSync(path.join(result, "music-library.sqlite"), "not a SQLite database");
    updateFileHash(result, "music-library.sqlite");
    await expect(restoreData({ backupDir: result, dataDir: target() })).rejects.toThrow();
    expect(fs.readdirSync(target())).toEqual([DATA_LOCK_FILE]);
  });

  it.each(["../outside", "/tmp/outside", "artwork/../../outside", "metadata/../outside", ".env", "metadata/.env", "metadata/sub/.env.production", "artwork/file\\name"])
    ("rejects an unsafe manifest path: %s", async (relative) => {
      const result = await backup();
      const value = manifest(result);
      value.files.push({ path: relative, size: 0, sha256: "0".repeat(64) });
      saveManifest(result, value);
      await expect(restoreData({ backupDir: result, dataDir: target() })).rejects.toThrow("非法、重复或越界");
      expect(fs.existsSync(target())).toBe(false);
    });

  it("rejects duplicate entries and unsupported manifest versions", async () => {
    const result = await backup();
    const value = manifest(result);
    saveManifest(result, { ...value, files: [...value.files, value.files[0]] });
    await expect(restoreData({ backupDir: result, dataDir: target() })).rejects.toThrow("非法、重复或越界");
    saveManifest(result, { ...value, version: 2 });
    await expect(restoreData({ backupDir: result, dataDir: target() })).rejects.toThrow("版本不受支持");
  });

  it.each(["artwork/linked.jpg", "metadata/linked-directory"])("rejects source cache symlinks and removes incomplete backups: %s", async (relative) => {
    fs.symlinkSync(relative.endsWith("directory") ? musicDir : path.join(musicDir, "song.mp3"), path.join(dataDir, relative));
    await expect(backup()).rejects.toThrow("软链接");
    expect(fs.readdirSync(path.join(dataDir, "backups"))).toEqual([]);
    expect(fs.readFileSync(path.join(musicDir, "song.mp3"), "utf8")).toBe("original music bytes");
  });

  it("rejects a database or SQLite sidecar symlink without opening it", async () => {
    fs.symlinkSync(path.join(musicDir, "song.mp3"), path.join(dataDir, "music-library.sqlite-wal"));
    await expect(backup()).rejects.toThrow("普通文件");
    fs.unlinkSync(path.join(dataDir, "music-library.sqlite-wal"));
    fs.renameSync(path.join(dataDir, "music-library.sqlite"), path.join(directory, "elsewhere.sqlite"));
    fs.symlinkSync(path.join(directory, "elsewhere.sqlite"), path.join(dataDir, "music-library.sqlite"));
    await expect(backup()).rejects.toThrow("普通文件");
  });

  it("rejects backup symlinks instead of following them during restore", async () => {
    const result = await backup();
    fs.unlinkSync(path.join(result, "artwork", "cover.jpg"));
    fs.symlinkSync(path.join(musicDir, "song.mp3"), path.join(result, "artwork", "cover.jpg"));
    await expect(restoreData({ backupDir: result, dataDir: target() })).rejects.toThrow("普通文件");
    expect(fs.readdirSync(target())).toEqual([DATA_LOCK_FILE]);
  });

  it("rejects music destinations through a symlink before creating any directories or locks", async () => {
    const result = await backup();
    const alias = path.join(directory, "music-alias");
    fs.symlinkSync(musicDir, alias);
    const before = fs.readdirSync(musicDir);
    await expect(restoreData({ backupDir: result, dataDir: path.join(alias, "new-directory") })).rejects.toThrow("音乐库");
    await expect(backupData({ dataDir: alias, musicLibraryPath: musicDir })).rejects.toThrow("音乐库");
    await expect(backupData({ dataDir, backupRoot: path.join(alias, "backups"), musicLibraryPath: musicDir })).rejects.toThrow("音乐库");
    expect(fs.readdirSync(musicDir)).toEqual(before);
  });

  it("protects the current music directory when the manifest lacks its root or names an old root", async () => {
    const result = await backup();
    const value = manifest(result);
    const alias = path.join(directory, "current-music-alias");
    fs.symlinkSync(musicDir, alias);
    const before = fs.readdirSync(musicDir);
    const output = { log: vi.fn(), error: vi.fn() };
    for (const oldRoot of [null, path.join(directory, "previous-music-root")]) {
      saveManifest(result, { ...value, source: { ...value.source, musicLibraryPath: oldRoot } });
      const destination = path.join(alias, "restore-target");
      expect(await main(["restore", "--backup", result, "--data-dir", destination], { MUSIC_LIBRARY_PATH: musicDir }, output)).toBe(1);
      expect(output.error.mock.calls.at(-1)?.[0]).toContain("音乐库");
      expect(await main(["restore", "--backup", result, "--data-dir", destination, "--music-library-path", musicDir], {}, output)).toBe(1);
      expect(fs.readdirSync(musicDir)).toEqual(before);
    }
  });

  it.each(["artwork", "metadata"])("rejects a backup destination inside source caches: %s", async (cache) => {
    const output = path.join(dataDir, cache, "nested-backups");
    await expect(backupData({ dataDir, backupRoot: output })).rejects.toThrow("缓存目录内");
    expect(fs.existsSync(output)).toBe(false);
  });

  it("cleans staged output after a backup copy fails and releases its lock", async () => {
    const original = fs.copyFileSync;
    vi.spyOn(fs, "copyFileSync").mockImplementation((...args) => {
      if (String(args[0]).endsWith("cover.jpg")) throw new Error("模拟复制失败");
      return original(...args);
    });
    await expect(backup()).rejects.toThrow("模拟复制失败");
    expect(fs.readdirSync(path.join(dataDir, "backups"))).toEqual([]);
    const lock = acquireDataLock(dataDir);
    lock.release();
  });

  it("rolls back only files published by a failed restore and removes its incomplete marker", async () => {
    const result = await backup();
    const original = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (String(source).includes(".music-restore-staging-") && path.basename(String(source)) === "metadata") throw new Error("模拟发布失败");
      return original(source, destination);
    });
    await expect(restoreData({ backupDir: result, dataDir: target() })).rejects.toThrow("模拟发布失败");
    expect(fs.readdirSync(target())).toEqual([DATA_LOCK_FILE]);
    expect(fs.readdirSync(directory).some((name) => name.startsWith(".music-restore-staging-"))).toBe(false);
    vi.restoreAllMocks();
    await restoreData({ backupDir: result, dataDir: target() });
  });

  it("refuses an interrupted restore target and preserves its marker", async () => {
    const result = await backup();
    fs.mkdirSync(target());
    fs.writeFileSync(path.join(target(), RESTORE_MARKER_FILE), "interrupted");
    await expect(restoreData({ backupDir: result, dataDir: target() })).rejects.toThrow("另一个全新或空目录");
    expect(fs.readFileSync(path.join(target(), RESTORE_MARKER_FILE), "utf8")).toBe("interrupted");
  });

  it("runs the CLI without authentication configuration and reports Chinese failures with a nonzero code", async () => {
    const output = { log: vi.fn(), error: vi.fn() };
    expect(await main(["--help"], { NODE_ENV: "production" }, output)).toBe(0);
    expect(output.log.mock.calls[0][0]).toContain("先停止");
    expect(await main(["backup"], {}, output)).toBe(1);
    expect(output.error.mock.calls.at(-1)?.[0]).toContain("必须通过 --data-dir");
    expect(await main(["backup", "--data-dir", dataDir], { NODE_ENV: "production" }, output)).toBe(0);
    const result = fs.readdirSync(path.join(dataDir, "backups"))[0];
    expect(manifest(path.join(dataDir, "backups", result)).source.musicLibraryPath).toBeNull();
    expect(await main(["restore", "--backup", path.join(dataDir, "backups", result)], { DATA_DIR: target(), NODE_ENV: "production" }, output)).toBe(0);
    expect(await main(["restore", "--backup", path.join(dataDir, "backups", result), "--data-dir", target()], {}, output)).toBe(1);
    expect(output.error.mock.calls.at(-1)?.[0]).toContain("不会覆盖已有数据");
  });
});
