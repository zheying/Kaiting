import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseFile } from "music-metadata";
import type { AppConfig } from "./config.js";
import type { DatabaseHandle, UpsertTrack } from "./db.js";
import { COVER_FILE_NAMES, inferFormatGroup, isSupportedAudioFile } from "./audio.js";
import { safeRealPath } from "./pathSafety.js";
import { enrichTrackMetadata } from "./metadata.js";

export interface Scanner {
  isRunning(): boolean;
  scan(): Promise<void>;
}

function trackIdForPath(filePath: string): string {
  return createHash("sha1").update(filePath).digest("hex").slice(0, 24);
}

function normalizeText(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ") || null;
  return value?.trim() || null;
}

async function walkAudioFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && isSupportedAudioFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  await walk(root);
  return files;
}

async function findSidecarLyrics(filePath: string): Promise<string | null> {
  const parsed = path.parse(filePath);
  const candidates = [
    path.join(parsed.dir, `${parsed.name}.lrc`),
    path.join(parsed.dir, `${parsed.name}.zh.lrc`)
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Ignore missing optional sidecars.
    }
  }

  return null;
}

async function findFolderArtwork(filePath: string): Promise<string | null> {
  const dir = path.dirname(filePath);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && COVER_FILE_NAMES.has(entry.name.toLowerCase())) {
        return path.join(dir, entry.name);
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function writeEmbeddedArtwork(config: AppConfig, trackId: string, picture?: { data: Uint8Array; format: string }): Promise<string | null> {
  if (!picture) return null;
  const ext = picture.format.includes("png") ? "png" : "jpg";
  const artworkPath = path.join(config.artworkDir, `${trackId}.${ext}`);
  await fs.writeFile(artworkPath, picture.data);
  return artworkPath;
}

async function inspectTrack(config: AppConfig, filePath: string): Promise<UpsertTrack> {
  const stat = await fs.stat(filePath);
  const metadata = await parseFile(filePath, { duration: true, skipCovers: false });
  const trackId = trackIdForPath(filePath);
  const common = metadata.common;
  const format = metadata.format;
  const embeddedArtwork = await writeEmbeddedArtwork(config, trackId, common.picture?.[0]);
  const folderArtwork = embeddedArtwork ? null : await findFolderArtwork(filePath);
  const lyricsPath = await findSidecarLyrics(filePath);
  const title = normalizeText(common.title) ?? path.basename(filePath, path.extname(filePath));
  const artist = normalizeText(common.artist ?? common.artists);
  const albumArtist = normalizeText(common.albumartist);
  const codec = normalizeText(format.codec);
  const container = normalizeText(format.container);

  return {
    id: trackId,
    path: filePath,
    fileName: path.basename(filePath),
    title,
    album: normalizeText(common.album),
    artist,
    albumArtist,
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
    artworkPath: embeddedArtwork ?? folderArtwork,
    lyricsPath,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

export function createScanner(config: AppConfig, database: DatabaseHandle): Scanner {
  let running = false;

  return {
    isRunning() {
      return running;
    },
    async scan() {
      if (running) return;
      running = true;
      const job = database.createScanJob();
      let scannedFiles = 0;
      let errorCount = 0;

      try {
        const root = safeRealPath(config.musicLibraryPath, config.musicLibraryPath);
        const files = await walkAudioFiles(root);
        const existingTrackCount = database.summary().trackCount;
        const seenPaths = new Set<string>();
        database.updateScanJob(job.id, { totalFiles: files.length, message: "正在扫描曲库" });

        if (files.length === 0) {
          database.updateScanJob(job.id, {
            status: "failed",
            scannedFiles: 0,
            errorCount: 1,
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
            const track = await inspectTrack(config, realFile);
            const enrichedTrack = await enrichTrackMetadata(config, database, track);
            database.upsertTrack(enrichedTrack);
          } catch (error) {
            errorCount += 1;
            database.recordScanError(job.id, filePath, error instanceof Error ? error.message : "未知扫描错误");
            console.warn(`Failed to scan ${filePath}`, error);
          } finally {
            scannedFiles += 1;
            if (scannedFiles % 20 === 0 || scannedFiles === files.length) {
              database.updateScanJob(job.id, {
                scannedFiles,
                errorCount,
                message: `已扫描 ${scannedFiles}/${files.length}`
              });
            }
          }
        }

        if (seenPaths.size === 0 && existingTrackCount > 0) {
          database.updateScanJob(job.id, {
            status: "failed",
            scannedFiles,
            errorCount: errorCount + 1,
            finishedAt: new Date().toISOString(),
            message: "扫描未能确认任何音频文件，已保留现有索引。请检查曲库路径权限。"
          });
          return;
        }

        const removed = database.removeMissingTracks(seenPaths);
        database.updateScanJob(job.id, {
          status: "completed",
          scannedFiles,
          errorCount,
          finishedAt: new Date().toISOString(),
          message: removed > 0 ? `扫描完成，移除了 ${removed} 个缺失文件` : "扫描完成"
        });
      } catch (error) {
        database.updateScanJob(job.id, {
          status: "failed",
          scannedFiles,
          errorCount: errorCount + 1,
          finishedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : "扫描失败"
        });
      } finally {
        running = false;
      }
    }
  };
}
