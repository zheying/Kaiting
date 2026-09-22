import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDataLock, DATA_LOCK_FILE, RESTORE_MARKER_FILE, type DataLock } from "../src/server/data-lock.js";

let directory: string;
const locks: DataLock[] = [];
const children: ChildProcess[] = [];

beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-data-lock-")); });

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const lock of locks.splice(0)) lock.release();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("data directory exclusive lock", () => {
  it("excludes a second owner, supports idempotent release, and preserves a newer owner's lock", () => {
    const first = acquireDataLock(directory);
    locks.push(first);
    expect(() => acquireDataLock(directory)).toThrow("请先停止服务");
    first.release();
    first.release();
    const second = acquireDataLock(directory);
    locks.push(second);
    first.release();
    expect(() => acquireDataLock(directory)).toThrow("请先停止服务");
  });

  it("serializes aliases of the same data directory", () => {
    const actual = path.join(directory, "actual");
    const alias = path.join(directory, "alias");
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, alias);
    locks.push(acquireDataLock(actual));
    expect(() => acquireDataLock(alias)).toThrow("请先停止服务");
  });

  it("excludes another process and automatically releases after an abrupt process exit", async () => {
    const modulePath = new URL("../src/server/data-lock.ts", import.meta.url).href;
    const script = `import { acquireDataLock } from ${JSON.stringify(modulePath)};
      const lock = acquireDataLock(${JSON.stringify(directory)});
      process.stdout.write('locked\\n');
      process.stdin.resume();`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`子进程未能持锁：${stderr}`)));
    });
    expect(() => acquireDataLock(directory)).toThrow("请先停止服务");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    locks.push(acquireDataLock(directory));
  });

  it.each([DATA_LOCK_FILE, `${DATA_LOCK_FILE}-journal`, `${DATA_LOCK_FILE}-wal`, `${DATA_LOCK_FILE}-shm`])
    ("rejects a symlink at the lock or a SQLite sidecar: %s", (name) => {
      const outside = path.join(directory, "outside");
      const data = path.join(directory, "data");
      fs.mkdirSync(data);
      fs.writeFileSync(outside, "do-not-touch");
      fs.symlinkSync(outside, path.join(data, name));
      expect(() => acquireDataLock(data)).toThrow("普通文件");
      expect(fs.readFileSync(outside, "utf8")).toBe("do-not-touch");
    });

  it("rejects incomplete restore directories without removing their marker", () => {
    fs.writeFileSync(path.join(directory, RESTORE_MARKER_FILE), "interrupted");
    expect(() => acquireDataLock(directory)).toThrow("另一个全新或空目录");
    expect(fs.readFileSync(path.join(directory, RESTORE_MARKER_FILE), "utf8")).toBe("interrupted");
  });
});
