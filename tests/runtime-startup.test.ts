import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { acquireDataLock, DATA_LOCK_FILE, RESTORE_MARKER_FILE } from "../src/server/data-lock.js";

describe("runtime startup exclusion", () => {
  it.each(["locked", "interrupted-restore"])("does not create runtime data before rejecting a %s target", (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-startup-"));
    const lock = acquireDataLock(directory);
    if (mode === "interrupted-restore") {
      lock.release();
      fs.writeFileSync(path.join(directory, RESTORE_MARKER_FILE), "unfinished");
    }
    const before = fs.readdirSync(directory).sort();
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
        cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 5_000,
        env: { ...process.env, NODE_ENV: "test", DATA_DIR: directory, MUSIC_LIBRARY_PATH: path.join(directory, "missing-music"),
          PORT: "56363", COOKIE_SECURE: "false", ENABLE_ONLINE_METADATA: "false", ADMIN_PASSWORD: "test", COOKIE_SECRET: "test-secret" }
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(mode === "locked" ? "正被服务或维护命令使用" : "未完成的数据恢复");
      expect(fs.readdirSync(directory).sort()).toEqual(before);
      expect(before).toContain(DATA_LOCK_FILE);
    } finally {
      lock.release();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
