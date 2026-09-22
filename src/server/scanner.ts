import fs from "node:fs/promises";
import { constants, statSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseFile } from "music-metadata";
import type { AppConfig } from "./config.js";
import type { DatabaseHandle, UpsertTrack } from "./db.js";
import type { ScanOptions } from "../shared/types.js";
import { COVER_FILE_NAMES, inferFormatGroup, isSupportedAudioFile } from "./audio.js";
import { safeRealPath } from "./pathSafety.js";
import { enrichTrackMetadata } from "./metadata.js";

export interface Scanner {
  isRunning(): boolean;
  scan(options?: ScanOptions): Promise<void>;
}

const SCANNER_VERSION = 1;

type FileInfo = { path: string; size: number; mtimeMs: number; ctimeMs: number };
type FileSnapshot = {
  signature: string;
  directoryIdentity: string;
  audio: FileInfo;
  lyricsPath: string | null;
  artworkPath: string | null;
};
type ScannerState = { signature: string; directory_identity: string };
type DirectoryInfo = { realPath: string; identity: string; stamp: string };
type CoverCandidates = Map<string, { stamp: string; names: string[] }>;

function trackIdForPath(filePath: string): string {
  return createHash("sha1").update(filePath).digest("hex").slice(0, 24);
}

function normalizeText(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ") || null;
  return value?.trim() || null;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)));
}

function scanFailureMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ENOENT" || code === "ENOTDIR") return "音乐目录不存在或已断开连接，请确认 NAS 已挂载，并检查 MUSIC_LIBRARY_PATH。";
  if (code === "EACCES" || code === "EPERM") return "无法读取音乐目录，请检查 NAS 挂载状态及当前账户的目录访问权限。";
  return error instanceof Error ? error.message : "扫描失败";
}

async function directoryInfo(root: string, directory: string): Promise<DirectoryInfo> {
  const realPath = safeRealPath(root, directory);
  const stat = await fs.stat(realPath);
  if (!stat.isDirectory()) throw new Error(`音乐目录已不可用：${directory}`);
  await fs.access(realPath, constants.R_OK | constants.X_OK);
  return {
    realPath,
    identity: JSON.stringify([realPath, stat.dev, stat.ino]),
    stamp: JSON.stringify([stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs])
  };
}

async function directoryIdentity(root: string, directory: string): Promise<string> {
  return (await directoryInfo(root, directory)).identity;
}

async function folderCoverCandidates(info: DirectoryInfo, cache: CoverCandidates): Promise<string[]> {
  const previous = cache.get(info.realPath);
  if (previous?.stamp === info.stamp) return previous.names;
  const entries = await fs.readdir(info.realPath, { withFileTypes: true });
  const names = entries.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && COVER_FILE_NAMES.has(entry.name.toLowerCase())).map((entry) => entry.name).sort();
  cache.set(info.realPath, { stamp: info.stamp, names });
  return names;
}

async function walkAudioFiles(root: string): Promise<{ files: string[]; directories: Map<string, string> }> {
  const files: string[] = [];
  const directories = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    const realDirectory = safeRealPath(root, directory);
    directories.set(realDirectory, await directoryIdentity(root, realDirectory));
    const entries = await fs.readdir(realDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(realDirectory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && isSupportedAudioFile(fullPath)) files.push(fullPath);
    }
  }
  await walk(root);
  return { files: files.sort(), directories };
}

async function optionalLocalFile(root: string, candidate: string): Promise<FileInfo | null> {
  try {
    const realFile = safeRealPath(root, candidate);
    const stat = await fs.stat(realFile);
    if (!stat.isFile()) return null;
    await fs.access(realFile, constants.R_OK);
    return { path: realFile, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function snapshotTrack(root: string, filePath: string, coverCandidates: CoverCandidates): Promise<FileSnapshot> {
  const realFile = safeRealPath(root, filePath);
  const stat = await fs.stat(realFile);
  if (!stat.isFile()) throw new Error(`音频文件已不可用：${filePath}`);
  await fs.access(realFile, constants.R_OK);
  const audio = { path: realFile, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  const parsed = path.parse(realFile);
  const directory = await directoryInfo(root, parsed.dir);
  const lyrics = await Promise.all([
    optionalLocalFile(root, path.join(parsed.dir, `${parsed.name}.lrc`)),
    optionalLocalFile(root, path.join(parsed.dir, `${parsed.name}.zh.lrc`))
  ]);
  const coverNames = await folderCoverCandidates(directory, coverCandidates);
  const covers = await Promise.all(coverNames.map((name) => optionalLocalFile(root, path.join(parsed.dir, name))));
  return {
    signature: JSON.stringify([SCANNER_VERSION, audio, lyrics, covers]),
    directoryIdentity: directory.identity,
    audio,
    lyricsPath: lyrics.find(Boolean)?.path ?? null,
    artworkPath: covers.find(Boolean)?.path ?? null
  };
}

async function writeEmbeddedArtwork(config: AppConfig, trackId: string, picture?: { data: Uint8Array; format: string }): Promise<string | null> {
  if (!picture) return null;
  safeRealPath(config.dataDir, config.artworkDir);
  const ext = picture.format.includes("png") ? "png" : "jpg";
  const artworkPath = path.join(config.artworkDir, `${trackId}.${ext}`);
  const temporary = path.join(config.artworkDir, `${trackId}-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, picture.data, { flag: "wx" });
    await fs.rename(temporary, artworkPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  return artworkPath;
}

async function inspectTrack(config: AppConfig, snapshot: FileSnapshot, existingId?: string): Promise<UpsertTrack> {
  const filePath = snapshot.audio.path;
  const metadata = await parseFile(filePath, { duration: true, skipCovers: false });
  const trackId = trackIdForPath(filePath);
  const common = metadata.common;
  const format = metadata.format;
  const embeddedArtwork = await writeEmbeddedArtwork(config, trackId, common.picture?.[0]);
  const codec = normalizeText(format.codec);
  const container = normalizeText(format.container);
  return {
    id: existingId ?? trackId,
    path: filePath,
    fileName: path.basename(filePath),
    title: normalizeText(common.title) ?? path.basename(filePath, path.extname(filePath)),
    album: normalizeText(common.album),
    artist: normalizeText(common.artist ?? common.artists),
    albumArtist: normalizeText(common.albumartist),
    genre: normalizeText(common.genre),
    year: common.year ?? null,
    trackNo: common.track.no ?? null,
    discNo: common.disk.no ?? null,
    duration: format.duration ?? null,
    bitrate: format.bitrate ? Math.round(format.bitrate) : null,
    codec,
    container,
    lossless: Boolean(format.lossless),
    formatGroup: inferFormatGroup(filePath, codec, container),
    artworkPath: embeddedArtwork ?? snapshot.artworkPath,
    lyricsPath: snapshot.lyricsPath,
    size: snapshot.audio.size,
    mtimeMs: snapshot.audio.mtimeMs
  };
}

async function existingResource(roots: string[], resourcePath: string | null | undefined): Promise<string | null> {
  if (!resourcePath) return null;
  for (const root of roots) {
    try {
      const safePath = safeRealPath(root, resourcePath);
      if ((await fs.stat(safePath)).isFile()) return resourcePath;
    } catch { /* Missing and unsafe resources must be rebuilt rather than retained. */ }
  }
  return null;
}

function metadataDatabase(config: AppConfig, database: DatabaseHandle, force: boolean): DatabaseHandle {
  const refreshed = new Set<string>();
  return {
    ...database,
    getMetadataCache(key) {
      if (force && !refreshed.has(key)) return null;
      const cached = database.getMetadataCache(key);
      if (cached && typeof cached === "object") {
        for (const [field, root] of [["artworkPath", config.artworkDir], ["lyricsPath", config.metadataDir]]) {
          const resource = (cached as Record<string, unknown>)[field];
          if (typeof resource !== "string") continue;
          try { if (!statSync(safeRealPath(root, resource)).isFile()) return null; }
          catch { return null; }
        }
      }
      return cached;
    },
    setMetadataCache(key, provider, payload) {
      database.setMetadataCache(key, provider, payload);
      refreshed.add(key);
    }
  };
}

export function createScanner(config: AppConfig, database: DatabaseHandle): Scanner {
  let running = false;
  database.db.exec(`
    CREATE TABLE IF NOT EXISTS scanner_state (
      path TEXT PRIMARY KEY,
      signature TEXT NOT NULL,
      directory_identity TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scanner_roots (
      path TEXT PRIMARY KEY,
      identity TEXT NOT NULL
    );
  `);
  const readState = database.db.prepare("SELECT signature, directory_identity FROM scanner_state WHERE path = ?");
  const writeState = database.db.prepare("INSERT INTO scanner_state (path, signature, directory_identity) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET signature = excluded.signature, directory_identity = excluded.directory_identity");
  const saveTrack = database.db.transaction((track: UpsertTrack, snapshot: FileSnapshot) => {
    database.upsertTrack(track);
    writeState.run(track.path, snapshot.signature, snapshot.directoryIdentity);
  });

  return {
    isRunning() { return running; },
    async scan(options: ScanOptions = {}) {
      if (running) return;
      const force = options.force === true;
      const prune = options.prune === true;
      const job = database.createScanJob({ force, prune });
      running = true;
      let scannedFiles = 0;
      let parsedFiles = 0;
      let skippedFiles = 0;
      let errorCount = 0;
      const onlineDatabase = metadataDatabase(config, database, force);
      const coverCandidates: CoverCandidates = new Map();
      try {
        const root = safeRealPath(config.musicLibraryPath, config.musicLibraryPath);
        const rootIdentity = await directoryIdentity(root, root);
        const previousRoot = database.db.prepare("SELECT identity FROM scanner_roots WHERE path = ?").get(root) as { identity: string } | undefined;
        const indexedPaths = database.listIndexedPaths();
        const { files, directories } = await walkAudioFiles(root);
        const existingTrackCount = indexedPaths.length;
        const seenPaths = new Set<string>();
        database.updateScanJob(job.id, { totalFiles: files.length, message: force ? "正在完整重扫曲库" : "正在增量扫描曲库" });
        if (files.length === 0) {
          database.updateScanJob(job.id, {
            status: "failed", scannedFiles: 0, parsedFiles: 0, skippedFiles: 0, errorCount: 1,
            finishedAt: new Date().toISOString(),
            message: existingTrackCount > 0
              ? "扫描未找到音频文件，已保留现有索引。请确认 NAS 音乐目录已挂载。"
              : "扫描未找到音频文件。请确认 MUSIC_LIBRARY_PATH 指向已挂载的 NAS 音乐目录。"
          });
          return;
        }
        for (const filePath of files) {
          try {
            const realFile = safeRealPath(root, filePath);
            seenPaths.add(realFile);
            const existing = database.getIndexedTrack(realFile);
            const state = readState.get(realFile) as ScannerState | undefined;
            const before = await snapshotTrack(root, realFile, coverCandidates);
            const resourcesValid = !existing || (
              (!existing.artworkPath || Boolean(await existingResource([root, config.artworkDir], existing.artworkPath))) &&
              (!existing.lyricsPath || Boolean(await existingResource([root, config.metadataDir], existing.lyricsPath)))
            );
            if (!force && existing && state?.signature === before.signature && existing.size === before.audio.size && existing.mtimeMs === before.audio.mtimeMs && resourcesValid) {
              skippedFiles += 1;
              if (state.directory_identity !== before.directoryIdentity) writeState.run(realFile, before.signature, before.directoryIdentity);
            } else {
              const track = await inspectTrack(config, before, existing?.id);
              track.artworkPath ??= await existingResource([config.artworkDir], existing?.artworkPath);
              track.lyricsPath ??= await existingResource([config.metadataDir], existing?.lyricsPath);
              const enriched = await enrichTrackMetadata(config, onlineDatabase, track);
              enriched.artworkPath = await existingResource([root, config.artworkDir], enriched.artworkPath);
              enriched.lyricsPath = await existingResource([root, config.metadataDir], enriched.lyricsPath);
              const after = await snapshotTrack(root, realFile, coverCandidates);
              if (before.signature !== after.signature) throw new Error("音频或伴随文件在扫描期间发生变化，将在下次扫描重试。");
              saveTrack(enriched, after);
              parsedFiles += 1;
            }
          } catch (error) {
            errorCount += 1;
            database.recordScanError(job.id, filePath, error instanceof Error ? error.message : "未知扫描错误");
            console.warn(`Failed to scan ${filePath}`, error);
          } finally {
            scannedFiles += 1;
            if (scannedFiles % 20 === 0 || scannedFiles === files.length) database.updateScanJob(job.id, {
              scannedFiles, parsedFiles, skippedFiles, errorCount,
              message: `已检查 ${scannedFiles}/${files.length}，解析 ${parsedFiles}，跳过 ${skippedFiles}`
            });
          }
        }

        if (await directoryIdentity(root, root) !== rootIdentity) throw new Error("扫描期间曲库挂载发生变化，已保留所有缺失索引。");
        const missingPaths: string[] = [];
        for (const indexed of indexedPaths) {
          if (seenPaths.has(indexed)) continue;
          try { if (seenPaths.has(safeRealPath(root, indexed))) continue; } catch { /* The optional prune checks validate missing paths below. */ }
          missingPaths.push(indexed);
        }
        let removed = 0;
        if (prune) {
          if (errorCount > 0) throw new Error(`扫描出现 ${errorCount} 个文件错误，未清理任何缺失索引。请解决错误后重试。`);
          if (previousRoot && previousRoot.identity !== rootIdentity && missingPaths.length > 0) throw new Error("曲库挂载身份已变化，未清理任何缺失索引。请确认原 NAS 已完整挂载。");
          for (const [directory, identity] of directories) {
            if (await directoryIdentity(root, directory) !== identity) throw new Error("扫描期间部分音乐目录发生变化，未清理任何缺失索引。");
          }
          for (const missing of missingPaths) {
            let identity: string;
            try { identity = await directoryIdentity(root, path.dirname(missing)); }
            catch { throw new Error("部分原音乐目录已不可访问，未清理任何缺失索引。请确认 NAS 子目录已完整挂载。"); }
            const state = readState.get(missing) as ScannerState | undefined;
            if (state && state.directory_identity !== identity) throw new Error("部分原音乐目录的挂载身份已变化，未清理任何缺失索引。");
            try {
              safeRealPath(root, missing);
              throw new Error("部分已索引文件未被本次遍历确认，未清理任何缺失索引。");
            } catch (error) { if (!isMissing(error)) throw error; }
          }
          removed = database.removeMissingTracks(seenPaths);
          database.db.exec("DELETE FROM scanner_state WHERE path NOT IN (SELECT path FROM tracks)");
        }
        if (errorCount === 0 && (missingPaths.length === 0 || !previousRoot)) database.db.prepare("INSERT INTO scanner_roots (path, identity) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET identity = excluded.identity").run(root, rootIdentity);
        const retained = prune ? 0 : missingPaths.length;
        database.updateScanJob(job.id, {
          status: "completed", scannedFiles, parsedFiles, skippedFiles, errorCount,
          finishedAt: new Date().toISOString(),
          message: `扫描完成：解析 ${parsedFiles}，跳过 ${skippedFiles}` + (removed ? `，清理了 ${removed} 首缺失歌曲的索引` : retained ? `，保留了 ${retained} 首缺失歌曲的索引` : "")
        });
      } catch (error) {
        database.updateScanJob(job.id, {
          status: "failed", scannedFiles, parsedFiles, skippedFiles, errorCount: errorCount || 1,
          finishedAt: new Date().toISOString(),
          message: `${scanFailureMessage(error)}${prune ? "（未清理缺失索引）" : "（已保留现有索引）"}`
        });
      } finally { running = false; }
    }
  };
}
