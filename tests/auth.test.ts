import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "../src/server/auth.js";
import type { AppConfig } from "../src/server/config.js";
import { openDatabase, type DatabaseHandle } from "../src/server/db.js";
import { registerRoutes } from "../src/server/routes.js";

const NOW = 1_800_000_000_000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
let directory: string;
let app: FastifyInstance;
let config: AppConfig;
let database: DatabaseHandle;


beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-auth-"));
  config = {
    port: 0,
    musicLibraryPath: path.join(directory, "music"),
    dataDir: directory,
    databasePath: path.join(directory, "library.sqlite"),
    artworkDir: path.join(directory, "artwork"),
    metadataDir: path.join(directory, "metadata"),
    adminPassword: "my-private-password",
    cookieSecret: randomBytes(32).toString("hex"),
    enableOnlineMetadata: false,
    isProduction: false
  };
  database = openDatabase(config.databasePath);
  app = Fastify();
  await app.register(cookie);
  await registerAuth(app, config, database);
  await registerRoutes(app, {
    config,
    database,
    scanner: { isRunning: () => false, scan: async () => undefined }
  });
});

afterEach(async () => {
  await app?.close();
  database?.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function login() {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: config.adminPassword } });
  expect(response.statusCode).toBe(200);
  return response.cookies[0];
}
const me = (token: string) => app.inject({ url: "/api/me", cookies: { ml_session: token } });

describe("production database session authentication", () => {
  it("leaves health public and protects account and library endpoints", async () => {
    expect((await app.inject("/api/health?check=1")).statusCode).toBe(200);
    for (const url of ["/api/me", "/api/summary", "/api/tracks"]) expect((await app.inject(url)).statusCode).toBe(401);
  });
  it("issues an opaque cookie with transport protections and authenticates it", async () => {
    const session = await login();
    expect(session).toMatchObject({ name: "ml_session", httpOnly: true, path: "/", sameSite: "Lax", maxAge: SESSION_TTL_SECONDS });
    expect(session.value).not.toMatch(/^admin\./);
    expect((await me(session.value)).json().user).toMatchObject({ id: "admin", username: "admin", role: "admin" });
  });
  it("wrong credentials cannot create a usable session", async () => {
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "wrong-password" } });
    expect(response.statusCode).toBe(401); expect(response.cookies).toEqual([]);
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  });
  it.each(["", "admin", "a.b.c.d", "a".repeat(257)])("rejects missing or fabricated cookie %j", async (token) => {
    expect((await me(token)).statusCode).toBe(401);
  });
  it("cannot authenticate a changed token or reuse one after a secret rotation", async () => {
    const { value } = await login();
    const changed = (value[0] === "A" ? "B" : "A") + value.slice(1);
    expect((await me(changed)).statusCode).toBe(401);
    expect((await me(value)).statusCode).toBe(200);
    config.cookieSecret = randomBytes(32).toString("hex");
    expect((await me(value)).statusCode).toBe(401);
  });
  it("rejects a once valid session exactly at its expiration deadline", async () => {
    const { value } = await login();
    vi.mocked(Date.now).mockReturnValue(NOW + SESSION_TTL_SECONDS * 1000 - 1);
    expect((await me(value)).statusCode).toBe(200);
    vi.mocked(Date.now).mockReturnValue(NOW + SESSION_TTL_SECONDS * 1000);
    expect((await me(value)).statusCode).toBe(401);
  });
  it.each([
    { production: true, configured: undefined, secure: true },
    { production: true, configured: false, secure: false },
    { production: false, configured: undefined, secure: false },
    { production: false, configured: true, secure: true }
  ])("sets cookie transport flags for $production / $configured", async ({ production, configured, secure }) => {
    config.isProduction = production; config.cookieSecure = configured;
    const session = await login();
    expect(Boolean(session.secure)).toBe(secure); expect(session.httpOnly).toBe(true);
  });
  it("logout clears the cookie and prevents replay of the revoked credential", async () => {
    const { value } = await login();
    const response = await app.inject({ method: "POST", url: "/api/auth/logout", cookies: { ml_session: value } });
    expect(response.statusCode).toBe(200);
    expect(response.cookies[0]).toMatchObject({ name: "ml_session", value: "", path: "/" });
    expect((await me(value)).statusCode).toBe(401);
  });
});
