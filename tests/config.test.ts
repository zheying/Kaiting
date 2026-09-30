import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/server/config.js";

let directory: string;
const TEST_SECRET = "8cf9409aa69bdc5f5c859f6055e25fcfd7a39767e2c7bfa226b90e4c5d134ea7";

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-config-"));
  for (const key of ["ADMIN_PASSWORD", "COOKIE_SECRET", "COOKIE_SECURE", "ENABLE_ONLINE_METADATA", "SCAN_ONLINE_METADATA", "AUTO_COMPLETE_ALBUM_METADATA", "PORT"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATA_DIR", path.join(directory, "data"));
  vi.stubEnv("MUSIC_LIBRARY_PATH", path.join(directory, "music"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function setProduction(): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ADMIN_PASSWORD", "my-private-password");
  vi.stubEnv("COOKIE_SECRET", TEST_SECRET);
}

describe("deployment configuration", () => {
  it("keeps local development usable and only reads configuration before the runtime lock is acquired", () => {
    const config = loadConfig();
    expect(config).toMatchObject({ adminPassword: "admin", isProduction: false, cookieSecure: false, port: 3000, enableOnlineMetadata: false });
    expect(config.cookieSecret).toBeTruthy();
    expect(config.databasePath).toBe(path.join(directory, "data", "music-library.sqlite"));
    expect(config.artworkDir).toBe(path.join(config.dataDir, "artwork"));
    expect(config.metadataDir).toBe(path.join(config.dataDir, "metadata"));
    expect(fs.existsSync(config.dataDir)).toBe(false);
    expect(fs.existsSync(config.musicLibraryPath)).toBe(false);
  });

  it("requires the production password before creating any runtime data", () => {
    setProduction();
    vi.stubEnv("ADMIN_PASSWORD", undefined);
    expect(() => loadConfig()).toThrow(/ADMIN_PASSWORD/);
    expect(fs.existsSync(path.join(directory, "data"))).toBe(false);
  });

  it.each([undefined, "", "   ", "short-secret", "x".repeat(31), "local-dev-cookie-secret", "replace-with-a-long-random-string", "change-me"])("rejects missing, weak or public production secret %j", (secret) => {
    setProduction();
    vi.stubEnv("COOKIE_SECRET", secret);
    expect(() => loadConfig()).toThrow(/COOKIE_SECRET/);
    expect(fs.existsSync(path.join(directory, "data"))).toBe(false);
  });

  it("accepts explicit production credentials and defaults to secure cookies", () => {
    setProduction();
    const config = loadConfig();
    expect(config).toMatchObject({ adminPassword: "my-private-password", cookieSecret: TEST_SECRET, cookieSecure: true, isProduction: true });
  });

  it.each(["false", "FALSE", "0", "off", "no"])("allows an explicit HTTP cookie setting %j for a LAN deployment", (value) => {
    setProduction();
    vi.stubEnv("COOKIE_SECURE", value);
    expect(loadConfig().cookieSecure).toBe(false);
  });

  it("honors HTTPS cookies, online metadata and a custom local port", () => {
    vi.stubEnv("COOKIE_SECURE", "true");
    vi.stubEnv("ENABLE_ONLINE_METADATA", "true");
    vi.stubEnv("PORT", "4321");
    expect(loadConfig()).toMatchObject({ cookieSecure: true, enableOnlineMetadata: true, port: 4321 });
  });

  it("allows background album completion without enabling per-track scan requests", () => {
    expect(loadConfig().scanOnlineMetadata).toBe(true);
    vi.stubEnv("ENABLE_ONLINE_METADATA", "true"); vi.stubEnv("SCAN_ONLINE_METADATA", "false");
    expect(loadConfig()).toMatchObject({ enableOnlineMetadata: true, scanOnlineMetadata: false, autoCompleteAlbumMetadata: true });
    vi.stubEnv("SCAN_ONLINE_METADATA", "invalid");
    expect(() => loadConfig()).toThrow(/SCAN_ONLINE_METADATA/);
  });

  it("does not silently disable secure cookies when configuration contains a typo", () => {
    setProduction();
    vi.stubEnv("COOKIE_SECURE", "ture");
    expect(() => loadConfig()).toThrow(/COOKIE_SECURE/);
  });

  it("defaults background album completion on behind the online gate, allows opt-out and rejects misspelled settings", () => {
    expect(loadConfig()).toMatchObject({ enableOnlineMetadata: false, autoCompleteAlbumMetadata: true });
    vi.stubEnv("AUTO_COMPLETE_ALBUM_METADATA", "false"); expect(loadConfig().autoCompleteAlbumMetadata).toBe(false);
    vi.stubEnv("AUTO_COMPLETE_ALBUM_METADATA", "true"); expect(loadConfig().autoCompleteAlbumMetadata).toBe(true);
    vi.stubEnv("AUTO_COMPLETE_ALBUM_METADATA", "invalid"); expect(() => loadConfig()).toThrow(/AUTO_COMPLETE_ALBUM_METADATA/);
  });

  it.each(["0", "65536", "-1", "3000.5", "not-a-port", ""])("rejects invalid configured port %j", (value) => {
    vi.stubEnv("PORT", value);
    expect(() => loadConfig()).toThrow(/PORT/);
  });
});
