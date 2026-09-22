import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/server/db.js";
import { registerRoutes } from "../src/server/routes.js";

let directory: string;
let database: DatabaseHandle;
let app: FastifyInstance;
const scan = vi.fn(async () => undefined);
let running = false;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-scan-recovery-"));
  database = openDatabase(path.join(directory, "music-library.sqlite"));
  scan.mockClear();
  running = false;
  app = Fastify();
  await registerRoutes(app, {
    database,
    config: {
      port: 0, musicLibraryPath: path.join(directory, "music"), dataDir: directory,
      databasePath: path.join(directory, "music-library.sqlite"),
      artworkDir: path.join(directory, "artwork"), metadataDir: path.join(directory, "metadata"),
      adminPassword: "test", cookieSecret: "test-only-cookie-secret-32-characters", enableOnlineMetadata: false, isProduction: false
    },
    scanner: { scan, isRunning: () => running }
  });
});

afterEach(async () => {
  await app.close();
  database.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("scan recovery and options", () => {
  it("migrates old scan records without losing counts or history", () => {
    const file = path.join(directory, "legacy.sqlite");
    const old = new Database(file);
    old.exec(`CREATE TABLE scan_jobs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      total_files INTEGER NOT NULL DEFAULT 0, scanned_files INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0, message TEXT
    ); INSERT INTO scan_jobs VALUES ('legacy', 'completed', '2026-01-01', '2026-01-02', 100, 99, 1, '历史记录');`);
    old.close();
    const migrated = openDatabase(file);
    try {
      expect(migrated.latestScan()).toMatchObject({ id: "legacy", status: "completed", totalFiles: 100, scannedFiles: 99,
        errorCount: 1, message: "历史记录", parsedFiles: 0, skippedFiles: 0, force: false, prune: false });
    } finally { migrated.db.close(); }
  });

  it("recovers all interrupted jobs once while preserving their progress and completed history", () => {
    const completed = database.createScanJob();
    database.updateScanJob(completed.id, { status: "completed", scannedFiles: 10, parsedFiles: 10 });
    const first = database.createScanJob({ force: true });
    database.updateScanJob(first.id, { totalFiles: 100, scannedFiles: 30, parsedFiles: 20, skippedFiles: 9, errorCount: 1 });
    const second = database.createScanJob({ prune: true });
    database.updateScanJob(second.id, { totalFiles: 10, scannedFiles: 3, skippedFiles: 3 });
    expect(database.recoverInterruptedScans()).toBe(2);
    expect(database.recoverInterruptedScans()).toBe(0);
    expect(database.latestScan()).toMatchObject({ id: second.id, status: "failed", totalFiles: 10, scannedFiles: 3,
      parsedFiles: 0, skippedFiles: 3, errorCount: 1, prune: true, finishedAt: expect.any(String) });
    expect(database.latestScan()?.message).toContain("服务中断");
    const rows = database.db.prepare("SELECT * FROM scan_jobs WHERE id = ?");
    expect(rows.get(first.id)).toMatchObject({ status: "failed", total_files: 100, scanned_files: 30, parsed_files: 20, skipped_files: 9, error_count: 2 });
    expect(rows.get(completed.id)).toMatchObject({ status: "completed", scanned_files: 10, error_count: 0 });
    const next = database.createScanJob();
    expect(next).toMatchObject({ status: "running", parsedFiles: 0, skippedFiles: 0, force: false, prune: false });
  });

  it("does not mark active scans interrupted merely because another database handle opens", () => {
    const job = database.createScanJob();
    const other = openDatabase(path.join(directory, "music-library.sqlite"));
    try { expect(other.latestScan()).toMatchObject({ id: job.id, status: "running" }); }
    finally { other.db.close(); }
  });

  it("updates the requested scan even when another job was created at the same timestamp", () => {
    const first = database.createScanJob();
    const second = database.createScanJob();
    database.db.prepare("UPDATE scan_jobs SET started_at = '2026-01-01'").run();
    database.updateScanJob(first.id, { scannedFiles: 12 });
    expect(database.db.prepare("SELECT scanned_files FROM scan_jobs WHERE id = ?").get(first.id)).toEqual({ scanned_files: 12 });
    expect(database.latestScan()?.id).toBe(second.id);
  });

  it.each([undefined, {}, { force: true }, { prune: true }, { force: false, prune: false }])("accepts scan options: %j", async (options) => {
    const response = await app.inject({ method: "POST", url: "/api/scan", ...(options ? { payload: options } : {}) });
    expect(response.statusCode).toBe(200);
    expect(scan).toHaveBeenCalledWith(options ?? {});
  });

  it.each([{ force: "true" }, { prune: 1 }, { force: null }, { prune: [true] }, []])("rejects non-boolean scan controls: %j", async (options) => {
    const response = await app.inject({ method: "POST", url: "/api/scan", payload: options });
    expect(response.statusCode).toBe(400);
    expect(scan).not.toHaveBeenCalled();
  });

  it("rejects duplicate scan submissions while a scan is active", async () => {
    running = true;
    expect((await app.inject({ method: "POST", url: "/api/scan" })).statusCode).toBe(409);
    expect(scan).not.toHaveBeenCalled();
  });
});
