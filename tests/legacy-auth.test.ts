import { createHmac, randomBytes } from "node:crypto";
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

function signedToken(user: string, expires: string, secret = config.cookieSecret): string {
  const payload = `${user}.${expires}`;
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

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
  await registerAuth(app, config);
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

describe("legacy HMAC session authentication", () => {
  it("requires a session for private API routes and leaves health public", async () => {
    expect((await app.inject({ url: "/api/health?check=1" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/me" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/summary" })).statusCode).toBe(401);
  });

  it("logs in with the configured password and authenticates its cookie", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login?source=web",
      payload: { password: config.adminPassword }
    });
    expect(login.statusCode).toBe(200);
    const session = login.cookies.find((entry) => entry.name === "ml_session");
    expect(session).toMatchObject({ httpOnly: true, path: "/", sameSite: "Lax", maxAge: SESSION_TTL_SECONDS });
    expect(session?.value.split(".").slice(0, 2)).toEqual(["admin", String(NOW + SESSION_TTL_SECONDS * 1000)]);
    const me = await app.inject({ url: "/api/me", cookies: { ml_session: session!.value } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toEqual({ name: "admin" });
  });

  it("rejects an incorrect password without creating a session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "my-invalid-password" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.cookies).toHaveLength(0);
  });

  it("rejects a forged cookie signed with the old public development key", async () => {
    const token = signedToken("admin", String(NOW + 60_000), "local-dev-cookie-secret");
    expect((await app.inject({ url: "/api/me", cookies: { ml_session: token } })).statusCode).toBe(401);
  });

  it.each(["guest", "administrator", "", "ADMIN"])("rejects a correctly signed cookie for identity %j", async (user) => {
    const token = signedToken(user, String(NOW + 60_000));
    expect((await app.inject({ url: "/api/me", cookies: { ml_session: token } })).statusCode).toBe(401);
  });

  it.each([
    "NaN", "Infinity", "-Infinity", "", "0", "-1", "1800000060000.5", "1.8e12",
    " 1800000060000", "01800000060000", "9007199254740992", String(NOW - 1), String(NOW)
  ])("rejects a correctly signed cookie with invalid or expired timestamp %j", async (expires) => {
    const token = signedToken("admin", expires);
    expect((await app.inject({ url: "/api/me", cookies: { ml_session: token } })).statusCode).toBe(401);
  });

  it.each(["", "admin", "admin.1800000060000", "admin.1800000060000.bad", "a.b.c.d"])("rejects malformed session %j", async (token) => {
    expect((await app.inject({ url: "/api/me", cookies: { ml_session: token } })).statusCode).toBe(401);
  });

  it("rejects a token after its signed payload changes", async () => {
    const token = signedToken("admin", String(NOW + 60_000)).replace(String(NOW + 60_000), String(NOW + 120_000));
    expect((await app.inject({ url: "/api/me", cookies: { ml_session: token } })).statusCode).toBe(401);
  });

  it("expires a previously valid token at its deadline", async () => {
    const token = signedToken("admin", String(NOW + 60_000));
    expect((await app.inject({ url: "/api/me", cookies: { ml_session: token } })).statusCode).toBe(200);
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
    expect((await app.inject({ url: "/api/me", cookies: { ml_session: token } })).statusCode).toBe(401);
  });

  it.each([
    { production: true, configured: undefined, secure: true },
    { production: true, configured: false, secure: false },
    { production: false, configured: undefined, secure: false },
    { production: false, configured: true, secure: true }
  ])("sets cookie transport flags for $production / $configured", async ({ production, configured, secure }) => {
    config.isProduction = production;
    config.cookieSecure = configured;
    const response = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { password: config.adminPassword }
    });
    expect(Boolean(response.cookies[0].secure)).toBe(secure);
    expect(response.cookies[0].httpOnly).toBe(true);
  });

  it("clears the session cookie when logging out", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/auth/logout",
      cookies: { ml_session: signedToken("admin", String(NOW + 60_000)) }
    });
    expect(response.statusCode).toBe(200);
    expect(response.cookies[0]).toMatchObject({ name: "ml_session", value: "", path: "/" });
    expect(new Date(response.cookies[0].expires!).getTime()).toBeLessThan(NOW);
  });
});
