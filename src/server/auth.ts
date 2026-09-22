import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";

const COOKIE_NAME = "ml_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

function sign(config: AppConfig, payload: string): string {
  return createHmac("sha256", config.cookieSecret).update(payload).digest("base64url");
}

function makeToken(config: AppConfig): string {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `admin.${expires}`;
  return `${payload}.${sign(config, payload)}`;
}

function verifyToken(config: AppConfig, token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  if (parts[0] !== "admin" || !/^[1-9]\d*$/.test(parts[1])) return false;
  const expires = Number(parts[1]);
  if (!Number.isSafeInteger(expires) || expires <= Date.now()) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = sign(config, payload);
  const actual = parts[2];

  try {
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function registerAuth(app: FastifyInstance, config: AppConfig): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    const routePath = request.routeOptions.url ?? request.url.split("?", 1)[0];
    if (routePath !== "/api" && !routePath.startsWith("/api/")) return;
    if (routePath === "/api/health" || routePath === "/api/auth/login") return;
    if (!verifyToken(config, request.cookies[COOKIE_NAME])) {
      return reply.status(401).send({ error: "未登录" });
    }
  });
}

export function setSession(reply: FastifyReply, config: AppConfig): void {
  reply.setCookie(COOKIE_NAME, makeToken(config), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure ?? config.isProduction,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: "/" });
}

export function isPasswordValid(request: FastifyRequest, config: AppConfig, password: string): boolean {
  if (typeof password !== "string") return false;
  const provided = Buffer.from(password);
  const expected = Buffer.from(config.adminPassword);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
