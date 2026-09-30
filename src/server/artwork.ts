import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { ArtworkSize } from "../shared/artwork.js";
import type { AppConfig } from "./config.js";
import { safeRealPath } from "./pathSafety.js";

// NAS memory/CPU are shared with audio playback. Avoid one native worker pool
// per image and never keep source file handles across cover replacements.
sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 32 });
const maxInputPixels = 40_000_000;
const maxInputBytes = 32 * 1024 * 1024;
const transformVersion = "webp-v1";

class ArtworkError extends Error {
  constructor(readonly statusCode: number, readonly publicMessage: string) { super(publicMessage); }
}
type ImageFile = { file: string; etag: string; type: string; bytes: number };
const fingerprint = (file: string, stat: Awaited<ReturnType<typeof fs.stat>>) =>
  `${file}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

export function createArtworkStore(config: AppConfig) {
  const pending = new Map<string, Promise<ImageFile>>();
  const waiting: (() => void)[] = [];
  let active = 0;

  async function limited<T>(work: () => Promise<T>): Promise<T> {
    if (active >= 2) {
      if (waiting.length >= 64) throw new ArtworkError(503, "封面正在载入，请稍后重试");
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else active++;
    try { return await work(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  }

  async function thumbnail(source: string, sourceVersion: string, key: string, size: ArtworkSize): Promise<ImageFile> {
    // Do not trust a pre-existing directory or cache entry: a symlink may have
    // changed since the last request. Derived files never go into MUSIC_LIBRARY_PATH.
    safeRealPath(config.dataDir, config.artworkDir);
    const directory = path.join(config.artworkDir, "thumbnails");
    await fs.mkdir(directory, { recursive: true });
    const safeDirectory = safeRealPath(config.artworkDir, directory);
    const target = path.join(safeDirectory, `${key}.webp`);
    const result = async (): Promise<ImageFile> => {
      const file = safeRealPath(safeDirectory, target);
      const stat = await fs.stat(file);
      if (!stat.isFile() || !stat.size) throw new ArtworkError(422, "封面无法读取");
      return { file, etag: `"${key}"`, type: "image/webp", bytes: stat.size };
    };
    try { return await result(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

    return limited(async () => {
      const temporary = path.join(safeDirectory, `${key}-${randomUUID()}.tmp`);
      try {
        // Reading into a bounded buffer avoids libvips retaining stale file
        // contents when an embedded cover is replaced at the same path.
        const input = await fs.readFile(source);
        if (input.length > maxInputBytes) throw new ArtworkError(422, "封面文件过大，暂时无法显示");
        try {
          await sharp(input, { limitInputPixels: maxInputPixels, failOn: "error" })
            .rotate().resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 82, effort: 3 }).timeout({ seconds: 10 }).toFile(temporary);
        } catch { throw new ArtworkError(422, "封面无法读取"); }
        if (fingerprint(source, await fs.stat(source)) !== sourceVersion) throw new ArtworkError(503, "封面正在更新，请稍后重试");
        await fs.rename(temporary, target);
        return await result();
      } finally { await fs.unlink(temporary).catch(() => {}); }
    });
  }

  return async (source: string, size?: ArtworkSize): Promise<ImageFile> => {
    const stat = await fs.stat(source);
    if (!stat.isFile()) throw new ArtworkError(404, "封面文件不存在");
    const sourceVersion = fingerprint(source, stat);
    const key = createHash("sha256").update(`${sourceVersion}\0${size ?? "original"}\0${transformVersion}`).digest("hex");
    if (!size) {
      const types: Record<string, string> = { ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif" };
      return { file: source, etag: `"${key}"`, type: types[path.extname(source).toLowerCase()] ?? "image/jpeg", bytes: stat.size };
    }
    if (stat.size > maxInputBytes) throw new ArtworkError(422, "封面文件过大，暂时无法显示");
    let image = pending.get(key);
    if (!image) {
      image = thumbnail(source, sourceVersion, key, size).finally(() => pending.delete(key));
      pending.set(key, image);
    }
    return image;
  };
}

export function matchesArtworkEtag(header: string | undefined, etag: string): boolean {
  return Boolean(header?.split(",").some((candidate) => candidate.trim() === "*" || candidate.trim().replace(/^W\//, "") === etag));
}
