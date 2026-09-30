import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "../src/server/auth.js";
import { createAccountStore, temporaryPassword } from "../src/server/accounts.js";
import { createDirectoryStore } from "../src/server/directories.js";
import { openDatabase, type DatabaseHandle, type UpsertTrack } from "../src/server/db.js";
import type { AppConfig } from "../src/server/config.js";
import { registerRoutes } from "../src/server/routes.js";
import { backupData, restoreData } from "../src/server/maintenance.js";

let root: string, config: AppConfig, database: DatabaseHandle, app: FastifyInstance, admin: string;
let running = false;
let scanner: { isRunning: () => boolean; scan: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
function track(id: string, base = config.musicLibraryPath): UpsertTrack {
  return { id, path: path.join(base, `${id}.mp3`), fileName: `${id}.mp3`, title: `歌曲 ${id}`, album: "共同的专辑", artist: "艺人", albumArtist: "艺人", genre: null, year: 2026, trackNo: 1, discNo: 1, duration: 60, bitrate: 128000, codec: "MP3", container: "MPEG", lossless: false, formatGroup: "mp3", artworkPath: null, lyricsPath: null, size: 10, mtimeMs: 1 };
}
const call = (url: string, session = admin, method: InjectOptions["method"] = "GET", payload?: Record<string, unknown>) => app.inject({ url, method, headers: { cookie: session }, ...(payload ? { payload } : {}) });
async function login(username: string, password: string) {
  const response = await app.inject({ url: "/api/auth/login", method: "POST", payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
}
async function member(username = "listener", role = "member") {
  const created = await call("/api/admin/users", admin, "POST", { username, displayName: username, role, grantConfirmed: role === "admin" });
  expect(created.statusCode).toBe(201);
  const result = created.json();
  const session = await login(username, result.temporaryPassword);
  const changed = await call("/api/auth/password", session, "POST", { currentPassword: result.temporaryPassword, password: "personal-password-123" });
  expect(changed.statusCode).toBe(200);
  return { ...result, session };
}
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "music-accounts-")));
  config = { port: 0, musicLibraryPath: path.join(root, "music"), musicLibraryRoots: [path.join(root, "second")], dataDir: path.join(root, "data"), databasePath: path.join(root, "data/music-library.sqlite"), artworkDir: path.join(root, "data/artwork"), metadataDir: path.join(root, "data/metadata"), adminPassword: "initial-admin-password", cookieSecret: "isolated-account-test-secret-at-least-32", cookieSecure: false, enableOnlineMetadata: false, isProduction: false };
  for (const directory of [config.musicLibraryPath, ...config.musicLibraryRoots!, config.artworkDir, config.metadataDir]) fs.mkdirSync(directory, { recursive: true });
  database = openDatabase(config.databasePath);
  for (const id of ["one", "two"]) { const value = track(id); fs.writeFileSync(value.path, "test audio"); database.upsertTrack(value); }
  running = false;
  scanner = { isRunning: () => running, scan: vi.fn(async () => { running = true; database.createScanJob(); }), stop: vi.fn(() => { running = false; const job = database.latestScan(); if (job) database.updateScanJob(job.id, { status: "interrupted" }); }) };
  app = Fastify(); await app.register(cookie); await registerAuth(app, config, database); await registerRoutes(app, { config, database, scanner });
  admin = await login("admin", config.adminPassword);
});
afterEach(async () => { await app.close(); vi.unstubAllGlobals(); if (database.db.open) database.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("real accounts, isolation, and first login", () => {
  it("generates temporary credentials on the server and requires a personal password before accessing data", async () => {
    const response = await call("/api/admin/users", admin, "POST", { username: "Newcomer", displayName: "初来", role: "member" });
    const { user, temporaryPassword: password } = response.json();
    expect(user).toMatchObject({ username: "newcomer", mustChangePassword: true });
    expect(password.length).toBeGreaterThanOrEqual(12); expect(password.length).toBeLessThanOrEqual(22);
    expect(JSON.stringify((await call("/api/admin/users")).json())).not.toContain(password);
    expect(database.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id)).not.toEqual({ password_hash: password });
    const session = await login("NEWCOMER", password);
    expect((await call("/api/tracks", session)).statusCode).toBe(403);
    expect((await call("/api/auth/password", session, "POST", { currentPassword: password, password })).statusCode).toBe(400);
    const changed = await call("/api/auth/password", session, "POST", { currentPassword: password, password: "my-personal-password" });
    expect(changed.json()).toMatchObject({ user: { mustChangePassword: false }, loggedOut: false });
    expect((await call("/api/tracks", session)).statusCode).toBe(200);
    const old = await app.inject({ url: "/api/auth/login", method: "POST", payload: { username: "newcomer", password } });
    expect(old.statusCode).toBe(401);
  });
  it("keeps every favorite and playlist read/write scoped to the authenticated account", async () => {
    const { session } = await member();
    const playlist = (await call("/api/playlists", admin, "POST", { name: "管理员私藏" })).json();
    await call(`/api/playlists/${playlist.id}/tracks`, admin, "POST", { trackId: "one" });
    await call("/api/tracks/one/favorite", admin, "PATCH", { favorite: true });
    for (const url of ["/api/tracks/one", "/api/tracks", "/api/search?q=歌曲", `/api/albums/${encodeURIComponent(database.listAlbums()[0].key)}`, `/api/artists/${encodeURIComponent("艺人")}`]) {
      const response = await call(url, session); expect(response.statusCode).toBe(200);
      const body = response.json(); const values = Array.isArray(body) ? body : body.tracks ?? [body];
      expect(values.every((item: { favorite: boolean }) => !item.favorite)).toBe(true);
    }
    expect((await call("/api/summary", session)).json()).toMatchObject({ favoriteCount: 0, playlistCount: 0 });
    expect((await call("/api/playlists", session)).json()).toEqual([]);
    for (const [method, suffix, payload] of [["GET", "", undefined], ["PATCH", "", { name: "偷改" }], ["DELETE", "", undefined], ["POST", "/tracks", { trackId: "two" }], ["DELETE", "/tracks/one", undefined], ["PUT", "/tracks/order", { trackIds: ["one"], revision: "guess" }]] as const) {
      expect((await call(`/api/playlists/${playlist.id}${suffix}`, session, method, payload)).statusCode).toBe(404);
    }
    await call("/api/tracks/two/favorite", session, "PATCH", { favorite: true });
    expect((await call("/api/tracks?favorite=true", session)).json().map((item: { id: string }) => item.id)).toEqual(["two"]);
    expect(database.getTrack("two")?.favorite).toBe(false);
    expect(database.getPlaylist(playlist.id)?.tracks.map((item) => item.id)).toEqual(["one"]);
  });
  it("enforces administrator privileges, consent, self-protection, and immediate revocation", async () => {
    const regular = await member();
    for (const [url, method, payload] of [["/api/admin/users", "GET", undefined], ["/api/directories", "GET", undefined], ["/api/scan", "POST", undefined], ["/api/scan/stop", "POST", undefined]] as const) expect((await call(url, regular.session, method, payload)).statusCode).toBe(403);
    expect((await call("/api/admin/users/admin", admin, "PATCH", { role: "member" })).statusCode).toBe(400);
    expect((await call(`/api/admin/users/${regular.user.id}`, admin, "PATCH", { role: "admin" })).statusCode).toBe(400);
    expect((await call(`/api/admin/users/${regular.user.id}`, admin, "PATCH", { status: "disabled" })).statusCode).toBe(200);
    expect((await call("/api/me", regular.session)).statusCode).toBe(401);
    const disabled = await app.inject({ url: "/api/auth/login", method: "POST", payload: { username: "listener", password: "personal-password-123" } }); expect(disabled.statusCode).toBe(403);
    await call(`/api/admin/users/${regular.user.id}`, admin, "PATCH", { status: "active" });
    const active = await login("listener", "personal-password-123");
    await call(`/api/admin/users/${regular.user.id}`, admin, "PATCH", { role: "admin", grantConfirmed: true });
    expect((await call("/api/me", active)).statusCode).toBe(401);
  });
  it("allows only the owner to revoke sessions and revokes all sessions on password changes", async () => {
    const regular = await member();
    const second = await login("listener", "personal-password-123");
    const sessions = (await call("/api/account/sessions", regular.session)).json();
    const other = sessions.find((item: { current: boolean }) => !item.current);
    await call("/api/account/sessions", admin, "DELETE", { ids: [other.id] });
    expect((await call("/api/me", second)).statusCode).toBe(200);
    await call("/api/account/sessions", regular.session, "DELETE", { ids: [other.id] });
    expect((await call("/api/me", second)).statusCode).toBe(401);
    expect((await call("/api/auth/password", regular.session, "POST", { currentPassword: "wrong", password: "new-valid-password" })).statusCode).toBe(400);
    const changed = await call("/api/auth/password", regular.session, "POST", { currentPassword: "personal-password-123", password: "new-valid-password" });
    expect(changed.json().loggedOut).toBe(true);
    expect((await call("/api/me", regular.session)).statusCode).toBe(401);
    expect(await login("listener", "new-valid-password")).toContain("ml_session=");
  });
  it("retries playlist creation idempotently without duplicating or leaking another user's result", async () => {
    const first = await call("/api/playlists", admin, "POST", { name: "重试歌单", requestId: "same-request" });
    const retry = await call("/api/playlists", admin, "POST", { name: "重试歌单", requestId: "same-request" });
    expect(first.json().id).toBe(retry.json().id);
    expect((await call("/api/playlists")).json()).toHaveLength(1);
    expect((await call("/api/playlists", admin, "POST", { name: "不同请求", requestId: "same-request" })).statusCode).toBe(409);
    const regular = await member();
    const theirs = await call("/api/playlists", regular.session, "POST", { name: "重试歌单", requestId: "same-request" });
    expect(theirs.json().id).not.toBe(first.json().id);
  });
  it("stores preferences independently without invalidating paginated library reads", async () => {
    const regular = await member(); const before = database.forUser(regular.user.id).pageTracks().revision;
    await call("/api/account/preferences", regular.session, "PATCH", { darkMode: true, queue: ["one", "two"], currentId: "two", position: 12, volume: 37 });
    expect((await call("/api/me", regular.session)).json().preferences).toMatchObject({ darkMode: true, currentId: "two", position: 12 });
    expect((await call("/api/me", admin)).json().preferences.darkMode).toBe(false);
    expect(database.forUser(regular.user.id).pageTracks().revision).toBe(before);
    expect((await call("/api/account/preferences", regular.session, "PATCH", { volume: 101 })).statusCode).toBe(400);
    expect((await call("/api/account/preferences", regular.session, "PATCH", { queue: ["one", "one"] })).statusCode).toBe(400);
    for (const repeat of [0, 1, 2]) {
      const preferences = { dense: false, darkMode: true, volume: 0, shuffle: false, repeat, queue: ["one", "two"], currentId: "two", position: 30.5 };
      const saved = await call("/api/account/preferences", regular.session, "PATCH", preferences);
      expect(saved.statusCode).toBe(200);
      expect((await call("/api/me", regular.session)).json().preferences).toEqual(preferences);
    }
    for (const repeat of ["1", false, 1.5, 3, null]) expect((await call("/api/account/preferences", regular.session, "PATCH", { repeat })).statusCode).toBe(400);
    await call(`/api/admin/users/${regular.user.id}/password`, admin, "POST", { password: "reset-temporary-123" });
    expect((await call("/api/me", regular.session)).statusCode).toBe(401);
    const fresh = await login("listener", "reset-temporary-123");
    expect((await call("/api/me", fresh)).json().user.mustChangePassword).toBe(true);
  });
  it("rejects foreign mutation origins and limits repeated login attempts", async () => {
    const foreign = await app.inject({ method: "PATCH", url: "/api/tracks/one/favorite", headers: { cookie: admin, origin: "https://foreign.example" }, payload: { favorite: true } }); expect(foreign.statusCode).toBe(403);
    for (let index = 0; index < 10; index++) await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "unknown", password: "invalid" } });
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "unknown", password: "invalid" } })).statusCode).toBe(429);
    for (let index = 0; index < 40; index++) { const value = temporaryPassword(); expect(value).toMatch(/[A-Z]/); expect(value).toMatch(/[a-z]/); expect(value).toMatch(/[0-9]/); expect(value).toMatch(/[!@#$%&*+\-_= ?]/); expect(value.length).toBeGreaterThanOrEqual(12); expect(value.length).toBeLessThanOrEqual(22); }
  });
  it("preserves old favorites and playlists, initialized credentials, and account data across backup/restore", async () => {
    const regular = await member();
    database.toggleFavorite("one", true); database.createPlaylist("原有歌单");
    database.forUser(regular.user.id).toggleFavorite("two", true); database.forUser(regular.user.id).createPlaylist("私人歌单");
    await call("/api/account/preferences", regular.session, "PATCH", { dense: true });
    await app.close(); database.db.close();
    const reopened = openDatabase(config.databasePath);
    const store = createAccountStore(reopened, { ...config, adminPassword: "should-not-reset-password" }); await store.initialize();
    expect((await store.login("admin", config.adminPassword, "migration")).id).toBe("admin");
    expect(reopened.summary()).toMatchObject({ favoriteCount: 1, playlistCount: 1 });
    expect(reopened.forUser(regular.user.id).summary()).toMatchObject({ favoriteCount: 1, playlistCount: 1 });
    reopened.db.close();
    const backup = await backupData({ dataDir: config.dataDir, musicLibraryPath: config.musicLibraryPath });
    const target = await restoreData({ backupDir: backup, dataDir: path.join(root, "restored") });
    const restored = openDatabase(path.join(target, "music-library.sqlite"));
    const accounts = createAccountStore(restored, config); await accounts.initialize();
    expect(accounts.preferences(regular.user.id).dense).toBe(true);
    expect((await accounts.login("listener", "personal-password-123", "restore")).id).toBe(regular.user.id);
    expect(restored.forUser(regular.user.id).listPlaylists()[0].name).toBe("私人歌单"); restored.db.close();
  });
});

describe("directory selection and real media states", () => {
  it("retains hidden playlist members and their slots when editing another directory", () => {
    const alternate = config.musicLibraryRoots![0];
    database.upsertTrack(track("other-one", alternate)); database.upsertTrack(track("other-two", alternate));
    database.setLibraryRoot(null);
    const list = database.createPlaylist("跨目录歌单");
    for (const id of ["one", "other-one", "two"]) database.addTrackToPlaylist(list.id, id);
    database.setLibraryRoot(config.musicLibraryPath);
    const before = database.getPlaylist(list.id)!;
    expect(database.reorderPlaylistTracks(list.id, ["two", "one"], before.revision).status).toBe("ok");
    database.setLibraryRoot(alternate);
    database.addTrackToPlaylist(list.id, "other-two");
    const all = () => (database.db.prepare("SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position").all(list.id) as { track_id: string; position: number }[]);
    expect(all().map((row) => row.track_id)).toEqual(["two", "other-one", "one", "other-two"]);
    database.removeTrackFromPlaylist(list.id, "other-one");
    expect(all()).toEqual([{ track_id: "two", position: 1 }, { track_id: "one", position: 2 }, { track_id: "other-two", position: 3 }]);
    database.setLibraryRoot(config.musicLibraryPath);
    expect(database.getPlaylist(list.id)!.tracks.map((item) => item.id)).toEqual(["two", "one"]);
  });
  it("selects an allowed mount, automatically scans, isolates its index, and prevents concurrent switches", async () => {
    const alternate = config.musicLibraryRoots![0]; database.upsertTrack(track("alternate", alternate));
    expect((await call("/api/tracks")).json()).toHaveLength(2);
    const response = await call("/api/directories", admin, "PUT", { path: alternate });
    expect(response.statusCode).toBe(200); expect(response.json().directory).toMatchObject({ path: alternate, configured: true, available: true });
    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect((await call("/api/tracks")).json().map((item: { id: string }) => item.id)).toEqual(["alternate"]);
    expect((await call("/api/directories", admin, "PUT", { path: path.join(root, "music") })).statusCode).toBe(409);
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM tracks").get()).toEqual({ count: 3 });
    await call("/api/scan/stop", admin, "POST"); expect(scanner.stop).toHaveBeenCalledOnce();
    expect((await call("/api/directories", admin, "PUT", { path: path.join(root, "music") })).statusCode).toBe(200);
    expect(scanner.scan).toHaveBeenCalledTimes(2);
  });
  it("rejects traversal and escaping symlinks without scanning or modifying music", async () => {
    fs.symlinkSync(config.dataDir, path.join(config.musicLibraryPath, "escape"));
    for (const candidate of [root, config.dataDir, path.join(config.musicLibraryPath, "escape"), path.join(config.musicLibraryPath, "missing")]) expect((await call("/api/directories", admin, "PUT", { path: candidate })).statusCode).toBe(400);
    expect(scanner.scan).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(config.musicLibraryPath, "one.mp3"), "utf8")).toBe("test audio");
    const options = (await call("/api/directories")).json().options;
    expect(options.find((item: { path: string }) => item.path.endsWith("escape")).available).toBe(false);
  });
  it("keeps a disconnected configured mount and exposes missing-file playback recovery", async () => {
    const original = config.musicLibraryPath; const store = createDirectoryStore(config, database);
    await store.select(original);
    expect((await call("/api/tracks/one/availability")).statusCode).toBe(200);
    fs.unlinkSync(path.join(original, "one.mp3"));
    expect((await call("/api/tracks/one/availability")).statusCode).toBe(404);
    fs.renameSync(original, `${original}-offline`);
    const restarted = createDirectoryStore({ ...config, musicLibraryPath: original }, database); await restarted.initialize();
    expect(await restarted.state()).toMatchObject({ path: original, configured: true, available: false });
    expect(database.summary().trackCount).toBe(2);
  });
});

describe("album information administration", () => {
  it("exposes catalog change notifications to signed-in listeners without leaking private paths or permitting writes", async () => {
    const { session } = await member();
    expect((await call("/api/catalog/status", "")).statusCode).toBe(401);
    const initial = (await call("/api/catalog/status", session)).json();
    expect(initial).toMatchObject({ revision: expect.any(String), scanRunning: false, enrichment: { enabled: false, state: "idle" } });
    expect(JSON.stringify(initial)).not.toContain(config.musicLibraryPath);
    const album = database.getAlbumMetadata(database.listAlbums()[0].key)!;
    database.saveAlbumMetadata(album.album.key, { year: 2026, genre: "原声" }, album.revision);
    expect((await call("/api/catalog/status", session)).json().revision).not.toBe(initial.revision);
    expect((await call("/api/catalog/status", session, "POST", {})).statusCode).not.toBe(200);
  });
  it("protects online searches by account, origin, configuration and metadata revision", async () => {
    const { session } = await member();
    const key = database.listAlbums()[0].key;
    const metadataUrl = `/api/admin/albums/${encodeURIComponent(key)}/metadata`;
    const endpoint = `${metadataUrl}/lookup`;
    const { revision, onlineLookupEnabled } = (await call(metadataUrl)).json();
    expect(onlineLookupEnabled).toBe(false);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ count: 0, releases: [] })));
    vi.stubGlobal("fetch", fetcher);
    expect((await call(endpoint, "", "POST", { revision })).statusCode).toBe(401);
    expect((await call(endpoint, session, "POST", { revision })).statusCode).toBe(403);
    expect((await call(endpoint, admin, "POST", { revision })).statusCode).toBe(409);
    config.enableOnlineMetadata = true;
    expect((await call(metadataUrl)).json().onlineLookupEnabled).toBe(true);
    expect((await call(endpoint, admin, "POST", { revision: "0".repeat(64) })).statusCode).toBe(409);
    expect((await call(endpoint, admin, "POST", {})).statusCode).toBe(400);
    expect((await app.inject({ url: endpoint, method: "POST", headers: { cookie: admin, origin: "https://foreign.invalid" }, payload: { revision } })).statusCode).toBe(403);
    expect((await call("/api/admin/albums/missing/metadata/lookup", admin, "POST", { revision })).statusCode).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
    const before = database.db.prepare("SELECT * FROM tracks ORDER BY id").all();
    const result = await call(endpoint, admin, "POST", { revision });
    expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ candidates: [], recommendedId: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(database.db.prepare("SELECT * FROM tracks ORDER BY id").all()).toEqual(before);
    expect(database.db.prepare("SELECT * FROM album_metadata_overrides").all()).toEqual([]);
  });
  it("rejects a lookup if the library changes while the network request is pending", async () => {
    config.enableOnlineMetadata = true;
    const key = database.listAlbums()[0].key;
    const { revision } = database.getAlbumMetadata(key)!;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      database.saveAlbumMetadata(key, { year: 2026, genre: "爵士" }, revision);
      return new Response(JSON.stringify({ count: 0, releases: [] }));
    }));
    const response = await call(`/api/admin/albums/${encodeURIComponent(key)}/metadata/lookup`, admin, "POST", { revision });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("重新载入");
  });
  it("allows administrators to supplement information and exposes the result to listeners", async () => {
    const { session } = await member();
    const key = database.listAlbums()[0].key;
    const endpoint = `/api/admin/albums/${encodeURIComponent(key)}/metadata`;
    const original = (await call(endpoint)).json();
    const change = { year: 2018, genre: " 游戏原声 ", revision: original.revision };
    expect((await call(endpoint, "")).statusCode).toBe(401);
    expect((await call(endpoint, session)).statusCode).toBe(403);
    expect((await call(endpoint, session, "PUT", change)).statusCode).toBe(403);
    const response = await call(endpoint, admin, "PUT", change);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ album: { key, year: 2018, genre: "游戏原声" }, original: { year: 2026, genre: null } });
    expect((await call("/api/albums", session)).json()[0]).toMatchObject({ year: 2018, genre: "游戏原声" });
    expect((await call(endpoint, admin, "PUT", change)).statusCode).toBe(409);
    const foreign = await app.inject({ url: endpoint, method: "PUT", headers: { cookie: admin, origin: "https://foreign.invalid" }, payload: { ...change, revision: response.json().revision } });
    expect(foreign.statusCode).toBe(403);
    const restored = await call(endpoint, admin, "PUT", { year: null, genre: null, revision: response.json().revision });
    expect(restored.json().album).toMatchObject({ year: 2026, genre: null });
  });
  it("rejects malformed or missing values before writing any supplement", async () => {
    const key = database.listAlbums()[0].key;
    const endpoint = `/api/admin/albums/${encodeURIComponent(key)}/metadata`;
    const { revision } = (await call(endpoint)).json();
    for (const body of [
      { year: "2018", genre: null, revision }, { year: 18, genre: null, revision },
      { year: 2018.5, genre: null, revision }, { year: 10000, genre: null, revision },
      { year: 2018, genre: "a".repeat(81), revision }, { year: 2018, genre: "Pop\nJazz", revision },
      { year: 2018, genre: 12, revision }, { year: 2018, genre: null }, { genre: null, revision }
    ]) expect((await call(endpoint, admin, "PUT", body)).statusCode).toBe(400);
    expect(database.db.prepare("SELECT * FROM album_metadata_overrides").all()).toEqual([]);
    expect((await call("/api/admin/albums/missing/metadata")).statusCode).toBe(404);
    expect((await call("/api/admin/albums/missing/metadata", admin, "PUT", { year: null, genre: null, revision })).statusCode).toBe(404);
  });
});
