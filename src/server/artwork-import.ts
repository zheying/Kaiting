import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireDataLock } from "./data-lock.js";
import { openDatabase, type DatabaseHandle } from "./db.js";
import { safeRealPath } from "./pathSafety.js";

/** Offline, missing-cover-only import. The audio library is never opened. */
export function importAlbumArtwork(options: { dataDir: string; albumKey: string; imagePath: string; sourceUrl: string }): { albumKey: string; updatedTracks: number; artworkPath: string | null } {
  const sourceUrl = new URL(options.sourceUrl);
  if (!["https:", "http:"].includes(sourceUrl.protocol) || sourceUrl.username || sourceUrl.password) throw new Error("封面来源必须是 HTTP(S) 地址");
  const sourcePath = path.resolve(options.imagePath);
  if (!fs.lstatSync(sourcePath).isFile()) throw new Error("封面必须是普通文件");
  const verifiedSource = safeRealPath(path.dirname(sourcePath), sourcePath);
  const size = fs.statSync(verifiedSource).size;
  if (size === 0 || size > 10 * 1024 * 1024) throw new Error("封面大小必须为 1 字节至 10 MB");
  const image = fs.readFileSync(verifiedSource);
  const extension = image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff ? "jpg" : null;
  if (!extension) throw new Error("只支持 PNG 或 JPEG 封面");

  const lock = acquireDataLock(options.dataDir);
  let database: DatabaseHandle | undefined;
  try {
    const databasePath = safeRealPath(lock.dataDir, path.join(lock.dataDir, "music-library.sqlite"));
    if (!fs.lstatSync(databasePath).isFile()) throw new Error("音乐库数据库不存在");
    database = openDatabase(databasePath);
    const detail = database.getAlbum(options.albumKey);
    if (!detail) throw new Error("找不到唯一匹配的专辑，请使用专辑 API 返回的 key");
    const missing = detail.tracks.filter((track) => !track.hasArtwork);
    if (!missing.length) return { albumKey: detail.album.key, updatedTracks: 0, artworkPath: null };
    const directory = path.join(lock.dataDir, "artwork");
    fs.mkdirSync(directory, { recursive: true });
    const safeDirectory = safeRealPath(lock.dataDir, directory);
    const hash = createHash("sha256").update(image).digest("hex");
    const destination = path.join(safeDirectory, `album-${hash}.${extension}`);
    if (fs.lstatSync(destination, { throwIfNoEntry: false })) {
      if (!fs.lstatSync(destination).isFile() || !fs.readFileSync(safeRealPath(lock.dataDir, destination)).equals(image)) throw new Error("已有封面缓存不匹配");
    } else {
      fs.writeFileSync(destination, image, { flag: "wx", mode: 0o600 });
    }
    const artworkPath = safeRealPath(lock.dataDir, destination);
    const update = database.db.prepare("UPDATE tracks SET artwork_path = ? WHERE id = ? AND artwork_path IS NULL");
    database.db.transaction(() => {
      for (const track of missing) update.run(artworkPath, track.id);
      database!.setMetadataCache(`album-artwork:${detail.album.key}`, "manual", {
        sourceUrl: sourceUrl.href, sha256: hash, artworkPath, importedAt: new Date().toISOString()
      });
    })();
    return { albumKey: detail.album.key, updatedTracks: missing.length, artworkPath };
  } finally {
    try { database?.db.close(); } finally { lock.release(); }
  }
}

export function main(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, output: Pick<Console, "log" | "error"> = console): number {
  try {
    if (args.includes("--help")) {
      output.log("请先停止服务，再执行：data:import-artwork -- --data-dir <目录> --album-key <专辑 key> --file <PNG/JPEG 文件> --source-url <来源网址>\n仅补齐缺失封面，写入 DATA_DIR；不修改音乐文件。DATA_DIR 可通过环境变量指定，不自动读取 .env。");
      return 0;
    }
    const flags = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index];
      const value = args[index + 1];
      if (!["--data-dir", "--album-key", "--file", "--source-url"].includes(name) || flags.has(name) || !value?.trim() || value.startsWith("--")) throw new Error(`命令参数不正确：${name}`);
      flags.set(name, value);
    }
    const dataDir = flags.get("--data-dir") ?? env.DATA_DIR;
    const albumKey = flags.get("--album-key");
    const imagePath = flags.get("--file");
    const sourceUrl = flags.get("--source-url");
    if (!dataDir?.trim() || !albumKey || !imagePath || !sourceUrl) throw new Error("缺少必要参数，使用 --help 查看帮助");
    output.log(JSON.stringify(importAlbumArtwork({ dataDir, albumKey, imagePath, sourceUrl })));
    return 0;
  } catch (error) {
    output.error(`封面导入失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = main();
