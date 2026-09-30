import fs from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { DatabaseHandle } from "./db.js";
import { safeRealPath } from "./pathSafety.js";
import type { DirectoryOption, DirectoryState } from "../shared/accounts.js";

export function createDirectoryStore(config: AppConfig, database: DatabaseHandle) {
  const db = database.db;
  // The deployment allowlist is fixed, even after the active directory changes.
  const roots = [...new Set([config.musicLibraryPath, ...(config.musicLibraryRoots ?? [])].map((root) => path.resolve(root)))];
  db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const read = (key: string) => (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  const configured = () => read("directory_configured") === "true";
  const canonical = (candidate: string) => {
    for (const root of roots) {
      try { return safeRealPath(root, candidate); } catch { /* Try the next explicitly allowed root. */ }
    }
    throw Object.assign(new Error("此目录不在允许访问的音乐目录中，或目录尚未挂载。"), { statusCode: 400, publicMessage: "此目录不在允许访问的音乐目录中，或目录尚未挂载。" });
  };
  const save = (key: string, value: string) => db.prepare("INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  const available = async (candidate: string) => {
    try { const real = canonical(candidate); const stat = await fs.stat(real); await fs.access(real, constants.R_OK | constants.X_OK); return stat.isDirectory(); }
    catch { return false; }
  };
  return {
    async initialize() {
      const persisted = read("music_directory");
      if (persisted) {
        // A disconnected NAS must keep its configured path. Never silently switch to another root.
        const allowed = roots.some((root) => { let real = root; try { real = realpathSync.native(root); } catch { /* A missing mount remains configured. */ } return [root, real].some((base) => { const relative = path.relative(base, persisted); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }); });
        if (allowed) config.musicLibraryPath = persisted;
      }
      if (read("directory_configured") === undefined) save("directory_configured", database.summary().trackCount > 0 || database.latestScan() ? "true" : "false");
      let active = config.musicLibraryPath;
      try { active = canonical(active); } catch { /* Offline roots keep their existing index scope. */ }
      database.setLibraryRoot(active);
    },
    async state(includeOptions = true, browsePath?: string): Promise<DirectoryState> {
      const options: DirectoryOption[] = [];
      if (includeOptions) {
        const candidates = new Set(roots);
        const selected = browsePath ? canonical(browsePath) : config.musicLibraryPath;
        candidates.add(selected);
        try {
          const safe = canonical(selected);
          const entries = await fs.readdir(safe, { withFileTypes: true });
          for (const entry of entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200)) candidates.add(path.join(safe, entry.name));
        } catch { /* Root options still allow recovery from an unavailable mount. */ }
        for (const candidate of candidates) {
          const readable = await available(candidate);
          options.push({ path: candidate, available: readable, detail: readable ? "音乐目录 · 可读" : "目录尚未挂载或不可读" });
        }
      }
      return { path: config.musicLibraryPath, configured: configured(), available: await available(config.musicLibraryPath), options };
    },
    async select(candidate: string) {
      const real = canonical(candidate);
      if (!await available(real)) throw Object.assign(new Error("音乐目录暂时不可读，请检查挂载状态和权限。"), { statusCode: 400, publicMessage: "音乐目录暂时不可读，请检查挂载状态和权限。" });
      db.transaction(() => { save("music_directory", path.resolve(candidate)); save("directory_configured", "true"); })();
      config.musicLibraryPath = real;
      database.setLibraryRoot(real);
      return this.state();
    }
  };
}
