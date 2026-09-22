import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { safeRealPath } from "./pathSafety.js";

export const DATA_LOCK_FILE = ".runtime-lock.sqlite";
export const RESTORE_MARKER_FILE = ".restore-in-progress";

export interface DataLock {
  dataDir: string;
  release(): void;
}

export function acquireDataLock(dataDir: string): DataLock {
  if (!dataDir.trim()) throw new Error("必须明确指定 DATA_DIR");
  const requested = path.resolve(dataDir);
  fs.mkdirSync(requested, { recursive: true });
  const root = fs.realpathSync.native(requested);
  const lockPath = path.join(root, DATA_LOCK_FILE);
  for (const name of [DATA_LOCK_FILE, `${DATA_LOCK_FILE}-journal`, `${DATA_LOCK_FILE}-wal`, `${DATA_LOCK_FILE}-shm`]) {
    const candidate = path.join(root, name);
    if (!fs.existsSync(candidate) && !fs.lstatSync(candidate, { throwIfNoEntry: false })) continue;
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("运行锁路径必须是 DATA_DIR 内的普通文件");
    safeRealPath(root, candidate);
  }

  let connection: Database.Database | undefined;
  try {
    connection = new Database(lockPath, { timeout: 0 });
    connection.pragma("busy_timeout = 0");
    connection.pragma("journal_mode = DELETE");
    // Initialize the empty lock file before holding a read-only exclusive
    // transaction, so an otherwise empty restore target needs no journal file.
    if (fs.statSync(lockPath).size === 0) connection.pragma("user_version = 1");
    connection.exec("BEGIN EXCLUSIVE");
    fs.chmodSync(lockPath, 0o600);
    if (fs.lstatSync(path.join(root, RESTORE_MARKER_FILE), { throwIfNoEntry: false })) {
      throw new Error("检测到未完成的数据恢复；请改用另一个全新或空目录重新恢复，不要删除恢复标记后启动服务");
    }
  } catch (error) {
    connection?.close();
    const code = (error as { code?: string }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      throw new Error("DATA_DIR 正被服务或维护命令使用，请先停止服务后重试");
    }
    throw error;
  }

  let released = false;
  return {
    dataDir: root,
    release() {
      if (released) return;
      released = true;
      try {
        if (connection?.inTransaction) connection.exec("ROLLBACK");
      } finally {
        connection?.close();
      }
    }
  };
}
