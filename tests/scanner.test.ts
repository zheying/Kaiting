import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFile, type IAudioMetadata } from "music-metadata";
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
  vi.mocked(parseFile).mockReset().mockRejectedValue(new Error("Invalid audio metadata"));
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

describe("scanner cached resources", () => {
  async function seedCachedTrack() {
    const config = makeConfig();
    fs.writeFileSync(path.join(libraryDir, "song.mp3"), "audio fixture");
    vi.mocked(parseFile).mockResolvedValue({
      common: { title: "Song", track: { no: 1, of: 1 }, disk: { no: 1, of: 1 } },
      format: { codec: "MPEG 1 Layer 3", container: "MPEG", duration: 180 },
      native: {}, quality: { warnings: [] }
    } as IAudioMetadata);
    const scanner = createScanner(config, database);
    await scanner.scan();
    const track = database.listTracks()[0];
    const artworkPath = path.join(config.artworkDir, "cached.jpg");
    const lyricsPath = path.join(config.metadataDir, "cached.lrc");
    fs.writeFileSync(artworkPath, "cached artwork");
    fs.writeFileSync(lyricsPath, "[00:00]Cached lyrics");
    database.db.prepare("UPDATE tracks SET artwork_path = ?, lyrics_path = ? WHERE id = ?")
      .run(artworkPath, lyricsPath, track.id);
    return { config, scanner, track, artworkPath, lyricsPath };
  }

  function resourcePaths(id: string) {
    return database.db.prepare("SELECT artwork_path, lyrics_path FROM tracks WHERE id = ?").get(id);
  }

  it("keeps existing cached artwork and lyrics when online metadata is disabled", async () => {
    const { scanner, track, artworkPath, lyricsPath } = await seedCachedTrack();
    database.toggleFavorite(track.id, true);
    const playlist = database.createPlaylist("Saved songs");
    database.addTrackToPlaylist(playlist.id, track.id);

    await scanner.scan();

    expect(resourcePaths(track.id)).toEqual({ artwork_path: artworkPath, lyrics_path: lyricsPath });
    expect(database.getTrack(track.id)?.favorite).toBe(true);
    expect(database.getPlaylist(playlist.id)?.tracks.map((item) => item.id)).toEqual([track.id]);
    expect(database.latestScan()).toMatchObject({ status: "completed", errorCount: 0 });
  });

  it.each(["missing", "directory", "outside", "symlink"])("drops %s cached resource paths on rescan", async (kind) => {
    const { scanner, track, artworkPath, lyricsPath } = await seedCachedTrack();
    fs.unlinkSync(artworkPath);
    fs.unlinkSync(lyricsPath);
    if (kind === "directory") {
      fs.mkdirSync(artworkPath);
      fs.mkdirSync(lyricsPath);
    } else if (kind === "outside" || kind === "symlink") {
      const outsideArtwork = path.join(dir, "outside.jpg");
      const outsideLyrics = path.join(dir, "outside.lrc");
      fs.writeFileSync(outsideArtwork, "outside artwork");
      fs.writeFileSync(outsideLyrics, "outside lyrics");
      if (kind === "symlink") {
        fs.symlinkSync(outsideArtwork, artworkPath);
        fs.symlinkSync(outsideLyrics, lyricsPath);
      } else {
        database.db.prepare("UPDATE tracks SET artwork_path = ?, lyrics_path = ? WHERE id = ?")
          .run(outsideArtwork, outsideLyrics, track.id);
      }
    }

    await scanner.scan();

    expect(resourcePaths(track.id)).toEqual({ artwork_path: null, lyrics_path: null });
    expect(database.latestScan()).toMatchObject({ status: "completed", errorCount: 0 });
  });

  it.each(["embedded", "folder"])("prefers new local lyrics and %s artwork over cached resources", async (kind) => {
    const { config, scanner, track } = await seedCachedTrack();
    const sidecar = path.join(libraryDir, "song.lrc");
    fs.writeFileSync(sidecar, "[00:00]Local lyrics");
    let artworkPath: string;
    if (kind === "embedded") {
      vi.mocked(parseFile).mockResolvedValue({
        common: {
          title: "Song", track: { no: 1, of: 1 }, disk: { no: 1, of: 1 },
          picture: [{ data: new Uint8Array([1, 2, 3]), format: "image/jpeg" }]
        },
        format: { codec: "MPEG 1 Layer 3", container: "MPEG", duration: 180 },
        native: {}, quality: { warnings: [] }
      } as IAudioMetadata);
      artworkPath = path.join(config.artworkDir, `${track.id}.jpg`);
    } else {
      const folderArtwork = path.join(libraryDir, "cover.jpg");
      fs.writeFileSync(folderArtwork, "local artwork");
      artworkPath = fs.realpathSync(folderArtwork);
    }

    await scanner.scan();

    expect(resourcePaths(track.id)).toEqual({ artwork_path: artworkPath, lyrics_path: fs.realpathSync(sidecar) });
    expect(database.latestScan()).toMatchObject({ status: "completed", errorCount: 0 });
  });
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

function validMetadata(title = "Song"): IAudioMetadata {
  return {
    common: { title, artist: "Artist", album: "Album", year: 2024, track: { no: 1, of: 1 }, disk: { no: 1, of: 1 } },
    format: { codec: "MPEG 1 Layer 3", container: "MPEG", duration: 180 },
    native: {}, quality: { warnings: [] }
  } as IAudioMetadata;
}

function writeAudio(name: string, content = "audio fixture"): string {
  const filePath = path.join(libraryDir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return fs.realpathSync(filePath);
}

function preserveUserState(trackId: string) {
  database.toggleFavorite(trackId, true);
  const playlist = database.createPlaylist("Daily listening");
  database.addTrackToPlaylist(playlist.id, trackId);
  return playlist.id;
}

describe("incremental scanner", () => {
  it("skips unchanged audio after the first successful parse without updating rows, FTS or user state", async () => {
    writeAudio("song.mp3");
    vi.mocked(parseFile).mockResolvedValue(validMetadata());
    const scanner = createScanner(makeConfig(), database);
    await scanner.scan();
    const track = database.listTracks()[0];
    const playlistId = preserveUserState(track.id);
    const beforeRow = database.db.prepare("SELECT * FROM tracks WHERE id = ?").get(track.id);
    const beforeFts = database.db.prepare("SELECT * FROM tracks_fts WHERE id = ?").get(track.id);
    const upsert = vi.spyOn(database, "upsertTrack");

    await scanner.scan();

    expect(parseFile).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalled();
    expect(database.db.prepare("SELECT * FROM tracks WHERE id = ?").get(track.id)).toEqual(beforeRow);
    expect(database.db.prepare("SELECT * FROM tracks_fts WHERE id = ?").get(track.id)).toEqual(beforeFts);
    expect(database.getPlaylist(playlistId)?.tracks.map((item) => item.id)).toEqual([track.id]);
    expect(database.latestScan()).toMatchObject({ status: "completed", scannedFiles: 1, parsedFiles: 0, skippedFiles: 1, force: false, prune: false });
  });

  it("enumerates a stable album directory only once for discovery and once for cover candidates", async () => {
    for (let index = 0; index < 12; index += 1) writeAudio(`song-${index}.mp3`);
    vi.mocked(parseFile).mockResolvedValue(validMetadata());
    const reads = vi.spyOn(fsPromises, "readdir");
    try {
      const scanner = createScanner(makeConfig(), database);
      await scanner.scan();
      expect(reads).toHaveBeenCalledTimes(2);
      await scanner.scan();
      expect(reads).toHaveBeenCalledTimes(4);
      expect(database.latestScan()).toMatchObject({ parsedFiles: 0, skippedFiles: 12 });
    } finally { reads.mockRestore(); }
  });

  it("does not remain running when creating the scan record fails", async () => {
    writeAudio("song.mp3");
    vi.mocked(parseFile).mockResolvedValue(validMetadata());
    const scanner = createScanner(makeConfig(), database);
    const create = vi.spyOn(database, "createScanJob").mockImplementationOnce(() => { throw new Error("database unavailable"); });
    await expect(scanner.scan()).rejects.toThrow("database unavailable");
    expect(scanner.isRunning()).toBe(false);
    await scanner.scan();
    expect(database.latestScan()).toMatchObject({ status: "completed", parsedFiles: 1 });
    create.mockRestore();
  });

  it("reparses changed audio and forces an unchanged file to be reparsed", async () => {
    const audio = writeAudio("song.m4a");
    vi.mocked(parseFile).mockResolvedValue({ ...validMetadata(), format: { codec: "AAC", container: "MPEG-4" } });
    const scanner = createScanner(makeConfig(), database);
    await scanner.scan();
    expect(database.listTracks()[0].formatGroup).toBe("m4a");
    fs.appendFileSync(audio, " changed");
    vi.mocked(parseFile).mockResolvedValue({ ...validMetadata("Lossless"), format: { codec: "ALAC", container: "MPEG-4", lossless: true } });
    await scanner.scan();
    expect(database.listTracks()[0]).toMatchObject({ title: "Lossless", formatGroup: "alac", lossless: true });
    await scanner.scan({ force: true });
    expect(parseFile).toHaveBeenCalledTimes(3);
    expect(database.latestScan()).toMatchObject({ parsedFiles: 1, skippedFiles: 0, force: true });
  });

  it("reparses legacy rows without a state marker while preserving their original track identity", async () => {
    const audio = writeAudio("song.mp3");
    insertTrack(audio);
    const playlistId = preserveUserState("track-1");
    vi.mocked(parseFile).mockResolvedValue(validMetadata("Updated legacy"));
    await createScanner(makeConfig(), database).scan();
    expect(database.listTracks()).toHaveLength(1);
    expect(database.getTrack("track-1")).toMatchObject({ title: "Updated legacy", favorite: true });
    expect(database.search("Updated").tracks.map((track) => track.id)).toEqual(["track-1"]);
    expect(database.getPlaylist(playlistId)?.tracks.map((track) => track.id)).toEqual(["track-1"]);
  });

  it.each(["song.lrc", "song.zh.lrc", "cover.jpg", "folder.png"])("detects %s being added, modified and removed", async (sidecarName) => {
    writeAudio("song.mp3");
    vi.mocked(parseFile).mockResolvedValue(validMetadata());
    const scanner = createScanner(makeConfig(), database);
    await scanner.scan();
    const sidecar = path.join(libraryDir, sidecarName);
    fs.writeFileSync(sidecar, "first resource");
    await scanner.scan();
    let track = database.listTracks()[0];
    expect(sidecarName.endsWith("lrc") ? track.hasLyrics : track.hasArtwork).toBe(true);
    fs.appendFileSync(sidecar, " updated resource");
    await scanner.scan();
    fs.unlinkSync(sidecar);
    await scanner.scan();
    track = database.listTracks()[0];
    expect(sidecarName.endsWith("lrc") ? track.hasLyrics : track.hasArtwork).toBe(false);
    expect(parseFile).toHaveBeenCalledTimes(4);
    await scanner.scan();
    expect(parseFile).toHaveBeenCalledTimes(4);
    expect(database.latestScan()?.skippedFiles).toBe(1);
  });

  it("does not record successful state when parsing fails, then retries on the next incremental scan", async () => {
    const audio = writeAudio("song.mp3");
    const scanner = createScanner(makeConfig(), database);
    await scanner.scan();
    expect(database.db.prepare("SELECT * FROM scanner_state WHERE path = ?").get(audio)).toBeUndefined();
    vi.mocked(parseFile).mockResolvedValue(validMetadata());
    await scanner.scan();
    expect(parseFile).toHaveBeenCalledTimes(2);
    expect(database.latestScan()).toMatchObject({ parsedFiles: 1, skippedFiles: 0, errorCount: 0 });
  });

  it("does not commit changed metadata or a marker when the source changes while being parsed", async () => {
    const audio = writeAudio("song.mp3");
    vi.mocked(parseFile).mockImplementationOnce(async () => {
      fs.appendFileSync(audio, " changed during parse");
      return validMetadata("Unstable");
    }).mockResolvedValue(validMetadata("Stable"));
    const scanner = createScanner(makeConfig(), database);
    await scanner.scan();
    expect(database.summary().trackCount).toBe(0);
    expect(database.db.prepare("SELECT * FROM scanner_state WHERE path = ?").get(audio)).toBeUndefined();
    expect(database.latestScan()).toMatchObject({ parsedFiles: 0, skippedFiles: 0, errorCount: 1 });
    await scanner.scan();
    expect(database.listTracks()[0].title).toBe("Stable");
    expect(parseFile).toHaveBeenCalledTimes(2);
  });

  it("lets force retry negative online lookups while normal scans avoid requests for unchanged audio", async () => {
    writeAudio("song.mp3");
    vi.mocked(parseFile).mockResolvedValue(validMetadata());
    const fetcher = vi.fn().mockImplementation(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const config = { ...makeConfig(), enableOnlineMetadata: true };
      const scanner = createScanner(config, database);
      await scanner.scan();
      const firstRequests = fetcher.mock.calls.length;
      expect(firstRequests).toBeGreaterThan(0);
      await scanner.scan();
      expect(fetcher).toHaveBeenCalledTimes(firstRequests);
      await scanner.scan({ force: true });
      expect(fetcher.mock.calls.length).toBeGreaterThan(firstRequests);
      expect(parseFile).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("explicit missing-index cleanup", () => {
  async function seedTwoTracks(nested = false) {
    const missing = writeAudio(nested ? "album/song.mp3" : "song.mp3");
    const remaining = writeAudio("remaining.mp3");
    vi.mocked(parseFile).mockResolvedValue(validMetadata());
    const scanner = createScanner(makeConfig(), database);
    await scanner.scan();
    const track = database.listTracks().find((item) => item.path === missing)!;
    const playlistId = preserveUserState(track.id);
    return { scanner, missing, remaining, track, playlistId };
  }

  it("retains missing tracks, favorites and playlist membership by default", async () => {
    const { scanner, missing, track, playlistId } = await seedTwoTracks();
    fs.unlinkSync(missing);
    await scanner.scan();
    expect(database.getTrack(track.id)?.favorite).toBe(true);
    expect(database.getPlaylist(playlistId)?.tracks.map((item) => item.id)).toEqual([track.id]);
    expect(database.latestScan()).toMatchObject({ status: "completed", parsedFiles: 0, skippedFiles: 1, prune: false });
    expect(database.latestScan()?.message).toContain("保留了 1 首缺失歌曲的索引");
  });

  it("removes missing indexes only after an explicit clean scan and keeps all remaining source files read-only", async () => {
    const { scanner, missing, remaining, track, playlistId } = await seedTwoTracks();
    const before = fs.readFileSync(remaining);
    fs.unlinkSync(missing);
    await scanner.scan({ prune: true });
    expect(database.getTrack(track.id)).toBeNull();
    expect(database.getPlaylist(playlistId)?.tracks).toEqual([]);
    expect(database.summary().trackCount).toBe(1);
    expect(fs.readFileSync(remaining)).toEqual(before);
    expect(database.db.prepare("SELECT * FROM scanner_state WHERE path = ?").get(missing)).toBeUndefined();
    expect(database.latestScan()).toMatchObject({ status: "completed", prune: true, errorCount: 0 });
  });

  it("refuses cleanup when a previous music subdirectory disappears even if other audio is still available", async () => {
    const { scanner, missing, track, playlistId } = await seedTwoTracks(true);
    fs.rmSync(path.dirname(missing), { recursive: true });
    await scanner.scan({ prune: true });
    expect(database.getTrack(track.id)?.favorite).toBe(true);
    expect(database.getPlaylist(playlistId)?.tracks).toHaveLength(1);
    expect(database.latestScan()).toMatchObject({ status: "failed", prune: true });
    expect(database.latestScan()?.message).toContain("原音乐目录已不可访问");
  });

  it("refuses cleanup when an original subdirectory is replaced with an empty mount point", async () => {
    const { scanner, missing, track } = await seedTwoTracks(true);
    const albumDirectory = path.dirname(missing);
    fs.renameSync(albumDirectory, path.join(dir, "old-album"));
    fs.mkdirSync(albumDirectory);
    await scanner.scan({ prune: true });
    expect(database.getTrack(track.id)?.favorite).toBe(true);
    expect(database.latestScan()).toMatchObject({ status: "failed", prune: true });
    expect(database.latestScan()?.message).toContain("挂载身份已变化");
  });

  it("refuses cleanup after the root mount changes, including after a default incremental scan", async () => {
    const { scanner, track } = await seedTwoTracks();
    fs.renameSync(libraryDir, path.join(dir, "old-music-mount"));
    fs.mkdirSync(libraryDir);
    writeAudio("new-mount-song.mp3");
    await scanner.scan();
    await scanner.scan({ prune: true });
    expect(database.getTrack(track.id)?.favorite).toBe(true);
    expect(database.latestScan()).toMatchObject({ status: "failed", prune: true });
    expect(database.latestScan()?.message).toContain("曲库挂载身份已变化");
  });

  it("explains a disconnected NAS root in Chinese and preserves all existing user data", async () => {
    const { scanner, track, playlistId } = await seedTwoTracks();
    fs.renameSync(libraryDir, path.join(dir, "disconnected-music"));
    await scanner.scan({ prune: true });
    expect(database.getTrack(track.id)?.favorite).toBe(true);
    expect(database.getPlaylist(playlistId)?.tracks).toHaveLength(1);
    expect(database.latestScan()).toMatchObject({ status: "failed", scannedFiles: 0 });
    expect(database.latestScan()?.message).toContain("音乐目录不存在或已断开连接");
    expect(database.latestScan()?.message).toContain("未清理缺失索引");
    expect(database.latestScan()?.message).not.toContain("ENOENT");
  });

  it.each(["ENOTDIR", "EACCES", "EPERM"])("explains root access failure %s in Chinese", async (code) => {
    const { scanner, track } = await seedTwoTracks();
    const stat = vi.spyOn(fsPromises, "stat").mockRejectedValueOnce(Object.assign(new Error("raw system failure"), { code }));
    try {
      await scanner.scan();
      expect(database.getTrack(track.id)?.favorite).toBe(true);
      expect(database.latestScan()).toMatchObject({ status: "failed", scannedFiles: 0 });
      expect(database.latestScan()?.message).toContain(code === "ENOTDIR" ? "音乐目录不存在或已断开连接" : "目录访问权限");
      expect(database.latestScan()?.message).not.toContain("raw system failure");
    } finally { stat.mockRestore(); }
  });

  it("preserves user data when directory enumeration fails", async () => {
    const { scanner, missing, track, playlistId } = await seedTwoTracks();
    fs.unlinkSync(missing);
    const reads = vi.spyOn(fsPromises, "readdir").mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    try {
      await scanner.scan({ prune: true });
      expect(database.getTrack(track.id)?.favorite).toBe(true);
      expect(database.getPlaylist(playlistId)?.tracks).toHaveLength(1);
      expect(database.latestScan()).toMatchObject({ status: "failed", scannedFiles: 0, prune: true });
      expect(database.latestScan()?.message).toContain("未清理缺失索引");
    } finally { reads.mockRestore(); }
  });

  it("refuses cleanup if any remaining file fails to parse", async () => {
    const { scanner, missing, remaining, track, playlistId } = await seedTwoTracks();
    fs.unlinkSync(missing);
    fs.appendFileSync(remaining, " changed");
    vi.mocked(parseFile).mockRejectedValue(new Error("NAS read failed"));
    await scanner.scan({ prune: true });
    expect(database.getTrack(track.id)?.favorite).toBe(true);
    expect(database.getPlaylist(playlistId)?.tracks).toHaveLength(1);
    expect(database.latestScan()).toMatchObject({ status: "failed", parsedFiles: 0, skippedFiles: 0, errorCount: 1 });
    expect(database.latestScan()?.message).toContain("未清理任何缺失索引");
  });

  it("preserves the index even with explicit prune when the whole library is empty", async () => {
    const { scanner, missing, remaining, track, playlistId } = await seedTwoTracks();
    fs.unlinkSync(missing);
    fs.unlinkSync(remaining);
    await scanner.scan({ prune: true });
    expect(database.getTrack(track.id)?.favorite).toBe(true);
    expect(database.getPlaylist(playlistId)?.tracks).toHaveLength(1);
    expect(database.latestScan()).toMatchObject({ status: "failed", totalFiles: 0, scannedFiles: 0, prune: true });
  });
});
