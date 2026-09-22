import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { acquireDataLock, DATA_LOCK_FILE, RESTORE_MARKER_FILE } from "./data-lock.js";
import { assertInsideRoot, safeRealPath } from "./pathSafety.js";

const DATABASE_FILE = "music-library.sqlite";
const MANIFEST_FILE = "manifest.json";
const CACHE_DIRECTORIES = ["artwork", "metadata"] as const;

interface BackupFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  source: { dataDir: string; realDataDir: string; musicLibraryPath: string | null };
  files: BackupFile[];
}

export interface BackupOptions {
  dataDir: string;
  backupRoot?: string;
  musicLibraryPath?: string;
}

export interface RestoreOptions {
  backupDir: string;
  dataDir: string;
  musicLibraryPath?: string;
}

function isSecretName(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

function allowedFile(relative: string): boolean {
  if (relative === DATABASE_FILE) return true;
  const parts = relative.split("/");
  return !relative.includes("\\") && parts.length >= 2 && CACHE_DIRECTORIES.some((name) => parts[0] === name)
    && parts.every((part) => part !== "" && part !== "." && part !== ".." && !isSecretName(part));
}

function regularFile(root: string, relative: string): string {
  const candidate = assertInsideRoot(root, path.join(root, relative));
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`备份仅允许普通文件：${relative}`);
  return safeRealPath(root, candidate);
}

function fingerprint(file: string): { size: number; sha256: string } {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error("备份文件不是普通文件");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      size += count;
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    fs.closeSync(descriptor);
  }
}

function walkCache(root: string, relative: string): string[] {
  const candidate = assertInsideRoot(root, path.join(root, relative));
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isSymbolicLink()) throw new Error(`缓存目录中不允许软链接：${relative}`);
  safeRealPath(root, candidate);
  if (stat.isFile()) {
    if (!allowedFile(relative)) throw new Error(`不允许的缓存文件路径：${relative}`);
    return [relative];
  }
  if (!stat.isDirectory()) throw new Error(`缓存目录中不允许特殊文件：${relative}`);
  return fs.readdirSync(candidate).sort().filter((name) => !isSecretName(name))
    .flatMap((name) => walkCache(root, `${relative}/${name}`));
}

function checkDatabase(file: string): void {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const checks = database.pragma("integrity_check") as { integrity_check: string }[];
    if (checks.length !== 1 || checks[0].integrity_check !== "ok") throw new Error("SQLite 数据库完整性检查失败");
    for (const table of ["tracks", "playlists", "playlist_tracks", "metadata_cache", "scan_jobs", "scan_errors"]) {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
        throw new Error(`备份缺少应用数据表：${table}`);
      }
    }
    if ((database.pragma("foreign_key_check") as unknown[]).length !== 0) throw new Error("SQLite 数据库关联数据检查失败");
  } finally {
    database.close();
  }
}

function copyFile(root: string, relative: string, destinationRoot: string): void {
  const source = regularFile(root, relative);
  const destination = assertInsideRoot(destinationRoot, path.join(destinationRoot, relative));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
}

function assertNotMusicDestination(destination: string, musicLibraryPath?: string): void {
  if (!musicLibraryPath) return;
  const configured = path.resolve(musicLibraryPath);
  const roots = [configured];
  if (fs.existsSync(configured)) roots.push(fs.realpathSync.native(configured));
  for (const root of roots) {
    const relative = path.relative(root, destination);
    if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      throw new Error("备份目录不能放在只读音乐库内");
    }
  }
}

function resolveFuturePath(requested: string): string {
  const missing: string[] = [];
  let existing = path.resolve(requested);
  while (!fs.lstatSync(existing, { throwIfNoEntry: false })) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync.native(existing), ...missing);
}

export async function backupData(options: BackupOptions): Promise<string> {
  if (!options.dataDir.trim()) throw new Error("必须明确指定 DATA_DIR");
  const requested = path.resolve(options.dataDir);
  if (!fs.existsSync(requested)) throw new Error("DATA_DIR 不存在，无法备份");
  assertNotMusicDestination(resolveFuturePath(requested), options.musicLibraryPath);
  const lock = acquireDataLock(requested);
  let staging: string | undefined;
  try {
    const source = regularFile(lock.dataDir, DATABASE_FILE);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const relative = `${DATABASE_FILE}${suffix}`;
      if (fs.lstatSync(path.join(lock.dataDir, relative), { throwIfNoEntry: false })) regularFile(lock.dataDir, relative);
    }
    checkDatabase(source);
    const backupRoot = path.resolve(options.backupRoot ?? path.join(lock.dataDir, "backups"));
    const prospectiveBackupRoot = resolveFuturePath(backupRoot);
    assertNotMusicDestination(prospectiveBackupRoot, options.musicLibraryPath);
    for (const name of CACHE_DIRECTORIES) {
      const relative = path.relative(path.join(lock.dataDir, name), prospectiveBackupRoot);
      if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
        throw new Error("备份输出目录不能位于 artwork 或 metadata 缓存目录内");
      }
    }
    if (fs.lstatSync(backupRoot, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("备份输出目录不能是软链接");
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const realBackupRoot = fs.realpathSync.native(backupRoot);
    assertNotMusicDestination(realBackupRoot, options.musicLibraryPath);
    const name = `backup-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    staging = fs.mkdtempSync(path.join(realBackupRoot, ".backup-incomplete-"));
    const snapshot = new Database(source, { readonly: true, fileMustExist: true });
    try {
      await snapshot.backup(path.join(staging, DATABASE_FILE));
    } finally {
      snapshot.close();
    }
    fs.chmodSync(path.join(staging, DATABASE_FILE), 0o600);
    checkDatabase(path.join(staging, DATABASE_FILE));
    const cacheFiles = CACHE_DIRECTORIES.flatMap((name) => walkCache(lock.dataDir, name));
    for (const relative of cacheFiles) copyFile(lock.dataDir, relative, staging);
    const files = [DATABASE_FILE, ...cacheFiles].sort().map((relative) => ({
      path: relative, ...fingerprint(regularFile(staging!, relative))
    }));
    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      source: { dataDir: requested, realDataDir: lock.dataDir, musicLibraryPath: options.musicLibraryPath ? path.resolve(options.musicLibraryPath) : null },
      files
    };
    fs.writeFileSync(path.join(staging, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const completed = path.join(realBackupRoot, name);
    fs.renameSync(staging, completed);
    staging = undefined;
    return completed;
  } finally {
    try {
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
    } finally {
      lock.release();
    }
  }
}

function readManifest(backupDir: string): BackupManifest {
  const manifestFile = regularFile(backupDir, MANIFEST_FILE);
  if (fs.statSync(manifestFile).size > 16 * 1024 * 1024) throw new Error("备份清单过大");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Partial<BackupManifest>;
  if (manifest.version !== 1 || typeof manifest.createdAt !== "string" || !manifest.source
    || typeof manifest.source.dataDir !== "string" || !path.isAbsolute(manifest.source.dataDir)
    || typeof manifest.source.realDataDir !== "string" || !path.isAbsolute(manifest.source.realDataDir)
    || !(manifest.source.musicLibraryPath === null || (typeof manifest.source.musicLibraryPath === "string" && path.isAbsolute(manifest.source.musicLibraryPath)))
    || !Array.isArray(manifest.files)) throw new Error("备份清单格式或版本不受支持");
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !allowedFile(file.path) || seen.has(file.path)
      || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("备份清单包含非法、重复或越界文件路径");
    }
    seen.add(file.path);
  }
  if (!seen.has(DATABASE_FILE)) throw new Error("备份清单缺少音乐库数据库");
  return manifest as BackupManifest;
}

function relocateCachePaths(databaseFile: string, staging: string, target: string, manifest: BackupManifest): void {
  const relocate = (value: unknown): unknown => {
    if (typeof value !== "string" || !path.isAbsolute(value)) return value;
    for (const root of new Set([manifest.source.dataDir, manifest.source.realDataDir])) {
      for (const category of CACHE_DIRECTORIES) {
        const relative = path.relative(path.join(root, category), value);
        if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
        const stagedPath = assertInsideRoot(staging, path.join(staging, category, relative));
        if (fs.existsSync(stagedPath)) safeRealPath(staging, stagedPath);
        return assertInsideRoot(target, path.join(target, category, relative));
      }
    }
    return value;
  };
  const relocatePayload = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(relocatePayload);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocatePayload(item)]));
    return relocate(value);
  };
  const database = new Database(databaseFile, { fileMustExist: true });
  try {
    database.pragma("journal_mode = DELETE");
    database.transaction(() => {
      const updateTrack = database.prepare("UPDATE tracks SET artwork_path = ?, lyrics_path = ? WHERE id = ?");
      for (const row of database.prepare("SELECT id, artwork_path, lyrics_path FROM tracks").all() as { id: string; artwork_path: string | null; lyrics_path: string | null }[]) {
        const artwork = relocate(row.artwork_path);
        const lyrics = relocate(row.lyrics_path);
        if (artwork !== row.artwork_path || lyrics !== row.lyrics_path) updateTrack.run(artwork, lyrics, row.id);
      }
      const updateCache = database.prepare("UPDATE metadata_cache SET payload = ? WHERE key = ?");
      for (const row of database.prepare("SELECT key, payload FROM metadata_cache").all() as { key: string; payload: string }[]) {
        let payload: unknown;
        try { payload = JSON.parse(row.payload); } catch { continue; }
        const relocated = JSON.stringify(relocatePayload(payload));
        if (relocated !== row.payload) updateCache.run(relocated, row.key);
      }
    })();
  } finally {
    database.close();
  }
}

export async function restoreData(options: RestoreOptions): Promise<string> {
  if (!options.dataDir.trim()) throw new Error("必须明确指定 DATA_DIR");
  const backupDir = fs.realpathSync.native(path.resolve(options.backupDir));
  const manifest = readManifest(backupDir);
  const requested = path.resolve(options.dataDir);
  const musicRoots = [options.musicLibraryPath, manifest.source.musicLibraryPath ?? undefined];
  for (const musicRoot of musicRoots) assertNotMusicDestination(resolveFuturePath(requested), musicRoot);
  const lock = acquireDataLock(requested);
  let staging: string | undefined;
  let marked = false;
  const moved: string[] = [];
  try {
    for (const musicRoot of musicRoots) assertNotMusicDestination(lock.dataDir, musicRoot);
    if (fs.readdirSync(lock.dataDir).some((name) => name !== DATA_LOCK_FILE)) {
      throw new Error("恢复只允许全新或空的 DATA_DIR，不会覆盖已有数据");
    }
    fs.writeFileSync(path.join(lock.dataDir, RESTORE_MARKER_FILE), JSON.stringify({ version: 1, backupDir, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    marked = true;
    // Keep staging on the target filesystem, including when DATA_DIR itself is
    // a mounted volume. An interruption during validation is also marked.
    staging = fs.mkdtempSync(path.join(lock.dataDir, ".music-restore-staging-"));
    for (const file of manifest.files) {
      const source = regularFile(backupDir, file.path);
      const actual = fingerprint(source);
      if (actual.size !== file.size || actual.sha256 !== file.sha256) throw new Error(`备份文件校验失败：${file.path}`);
      copyFile(backupDir, file.path, staging);
      const copied = fingerprint(regularFile(staging, file.path));
      if (copied.size !== file.size || copied.sha256 !== file.sha256) throw new Error(`备份复制校验失败：${file.path}`);
    }
    const stagedDatabase = regularFile(staging, DATABASE_FILE);
    checkDatabase(stagedDatabase);
    relocateCachePaths(stagedDatabase, staging, lock.dataDir, manifest);
    checkDatabase(stagedDatabase);
    for (const name of CACHE_DIRECTORIES) fs.mkdirSync(path.join(staging, name), { recursive: true });
    // Keep the lock database inode in place. The marker makes this publication
    // atomic to every service/maintenance process using acquireDataLock, even
    // if this process is terminated between individual renames.
    for (const name of [DATABASE_FILE, ...CACHE_DIRECTORIES]) {
      if (fs.lstatSync(path.join(lock.dataDir, name), { throwIfNoEntry: false })) throw new Error("恢复目标在操作期间发生变化");
      fs.renameSync(path.join(staging, name), path.join(lock.dataDir, name));
      moved.push(name);
    }
    fs.unlinkSync(path.join(lock.dataDir, RESTORE_MARKER_FILE));
    marked = false;
    return lock.dataDir;
  } catch (error) {
    for (const name of moved.reverse()) fs.rmSync(path.join(lock.dataDir, name), { recursive: true, force: true });
    if (staging) {
      fs.rmSync(staging, { recursive: true, force: true });
      staging = undefined;
    }
    if (marked) fs.unlinkSync(path.join(lock.dataDir, RESTORE_MARKER_FILE));
    throw error;
  } finally {
    try {
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
    } finally {
      lock.release();
    }
  }
}

export const MAINTENANCE_HELP = `音乐库数据维护（请先停止音乐播放器服务）
  backup --data-dir <目录> [--backup-root <备份父目录>] [--music-library-path <只读音乐目录>]
  restore --backup <备份目录> --data-dir <全新或空目录> [--music-library-path <当前只读音乐目录>]

DATA_DIR 和 MUSIC_LIBRARY_PATH 可通过环境变量提供；不会自动读取 .env。
备份默认写入 DATA_DIR/backups，只包含数据库及 artwork/metadata，不包含音乐文件或 .env。
恢复不会覆盖已有数据，也不会更改音乐挂载路径或歌曲 ID。
若恢复被中断，请改用另一个全新或空目录重新恢复；不要删除恢复标记后强行启动。`;

export async function main(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, output: Pick<Console, "log" | "error"> = console): Promise<number> {
  try {
    if (args.includes("--help") || args.includes("-h")) { output.log(MAINTENANCE_HELP); return 0; }
    const [command, ...rest] = args;
    if (command !== "backup" && command !== "restore") throw new Error("请指定 backup 或 restore；使用 --help 查看帮助");
    const flags = new Map<string, string>();
    const allowed = command === "backup" ? ["--data-dir", "--backup-root", "--music-library-path"] : ["--data-dir", "--backup", "--music-library-path"];
    for (let index = 0; index < rest.length; index += 2) {
      const name = rest[index];
      const value = rest[index + 1];
      if (!allowed.includes(name) || flags.has(name) || !value?.trim() || value.startsWith("--")) throw new Error(`命令参数不正确：${name}`);
      flags.set(name, value);
    }
    const dataDir = flags.get("--data-dir") ?? env.DATA_DIR;
    if (!dataDir?.trim()) throw new Error("必须通过 --data-dir 或 DATA_DIR 明确指定数据目录");
    if (command === "backup") {
      const result = await backupData({ dataDir, backupRoot: flags.get("--backup-root"), musicLibraryPath: flags.get("--music-library-path") ?? env.MUSIC_LIBRARY_PATH });
      output.log(`备份完成：${result}`);
    } else {
      const backupDir = flags.get("--backup");
      if (!backupDir) throw new Error("恢复必须提供 --backup <备份目录>");
      const result = await restoreData({ dataDir, backupDir, musicLibraryPath: flags.get("--music-library-path") ?? env.MUSIC_LIBRARY_PATH });
      output.log(`恢复完成：${result}。音乐挂载路径保持不变，请确认路径可用后启动服务。`);
    }
    return 0;
  } catch (error) {
    output.error(`数据维护失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().then((code) => { process.exitCode = code; });
}
