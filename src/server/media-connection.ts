import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import type { AccountStore } from "./accounts.js";

const lifetime = 15 * 60;
const mediaPath = /^\/api\/tracks\/[^/?]+\/(stream|artwork)$/;
const routePath = (request: FastifyRequest) => request.url.split("?", 1)[0];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function registerMediaConnection(app: FastifyInstance, config: AppConfig, accounts: AccountStore) {
  const settings = config.mediaConnection;
  const directHost = settings && new URL(settings.directOrigin).host;
  const publicHost = settings && new URL(settings.publicOrigin).host;
  const isDirect = (request: FastifyRequest) => Boolean(directHost && request.headers.host?.toLowerCase() === directHost);
  const isPublic = (request: FastifyRequest) => Boolean(publicHost && request.headers.host?.toLowerCase() === publicHost);
  const signature = (value: string) => createHmac("sha256", config.cookieSecret).update(`media-v1:${value}`).digest("base64url");
  const instance = signature(`instance:${config.databasePath}`);
  // 一次性票据仅留存一分钟，并设总量上限；进程重启后旧票据自然失效。
  const tickets = new Map<string, { sessionId: string; expires: number }>();
  function issueCookie(sessionId: string) {
    const payload = Buffer.from(JSON.stringify({ sessionId, expires: Date.now() + lifetime * 1000, audience: settings!.directOrigin })).toString("base64url");
    return `${payload}.${signature(payload)}`;
  }
  function authenticate(token: string | undefined) {
    if (!token || token.length > 2048) return null;
    try {
      const [payload, provided, extra] = token.split(".");
      if (!payload || !provided || extra !== undefined) return null;
      const expected = Buffer.from(signature(payload)); const actual = Buffer.from(provided);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      const value = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (value.audience !== settings?.directOrigin || !Number.isSafeInteger(value.expires) || value.expires <= Date.now() || typeof value.sessionId !== "string") return null;
      return accounts.mediaSession(value.sessionId);
    } catch { return null; }
  }
  function allowedMethod(path: string) { return path === "/api/media/connect" ? "POST" : "GET"; }
  function allowedPath(path: string) { return mediaPath.test(path) || ["/api/media/probe", "/api/media/connect", "/api/media/status"].includes(path); }

  app.addHook("onRequest", async (request, reply) => {
    if (!isDirect(request)) return;
    const path = routePath(request);
    reply.header("Cache-Control", "no-store");
    if (path === "/api/health" && ["GET", "HEAD"].includes(request.method)) return;
    if (!allowedPath(path)) return reply.status(404).send({ error: "此入口只提供媒体连接。" });
    const origin = request.headers.origin;
    // CSS/系统封面可能不带 Origin；有 Origin 的请求必须精确匹配页面入口。
    if ((origin && origin !== settings!.publicOrigin) || (!origin && !mediaPath.test(path))) return reply.status(403).send({ error: "请求来源不受信任。" });
    if (origin) {
      reply.header("Access-Control-Allow-Origin", settings!.publicOrigin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges");
      reply.header("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      const method = request.headers["access-control-request-method"];
      const headers = String(request.headers["access-control-request-headers"] ?? "").toLowerCase().split(",").map((v) => v.trim()).filter(Boolean);
      if (!origin || (method !== allowedMethod(path) && !(method === "HEAD" && allowedMethod(path) === "GET")) || headers.some((h) => !["content-type", "range"].includes(h))) return reply.status(403).send({ error: "不允许此跨域请求。" });
      reply.header("Access-Control-Allow-Methods", allowedMethod(path) === "GET" ? "GET, HEAD" : "POST");
      reply.header("Access-Control-Allow-Headers", "Content-Type, Range");
      reply.header("Access-Control-Max-Age", "600");
      // 兼容仍使用 Private Network Access 预检的浏览器。
      if (request.headers["access-control-request-private-network"] === "true") reply.header("Access-Control-Allow-Private-Network", "true");
      return reply.status(204).send();
    }
    if (request.method !== allowedMethod(path) && !(request.method === "HEAD" && allowedMethod(path) === "GET")) return reply.status(405).send({ error: "媒体入口仅允许读取与握手。" });
  });

  app.get("/api/media/connection", async (request) => isPublic(request) ? { enabled: true, ...settings, instance } : { enabled: false });
  app.post("/api/media/connection", { bodyLimit: 1024 }, async (request, reply) => {
    if (!isPublic(request)) return reply.status(404).send({ error: "未启用局域网直连。" });
    for (const [key, entry] of tickets) if (entry.expires <= Date.now()) tickets.delete(key);
    if (tickets.size >= 2048) return reply.status(429).send({ error: "请稍后重新检测。" });
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(hash(ticket), { sessionId: request.sessionId!, expires: Date.now() + 60_000 });
    return { ticket };
  });
  app.get("/api/media/probe", async (request, reply) => isDirect(request) ? { instance } : reply.status(404).send());
  app.post<{ Body: { ticket: string } }>("/api/media/connect", {
    bodyLimit: 1024,
    schema: { body: { type: "object", required: ["ticket"], additionalProperties: false, properties: { ticket: { type: "string", minLength: 1, maxLength: 256 } } } }
  }, async (request, reply) => {
    if (!isDirect(request)) return reply.status(404).send();
    const key = hash(request.body.ticket); const entry = tickets.get(key);
    tickets.delete(key);
    if (!entry || entry.expires <= Date.now() || !accounts.mediaSession(entry.sessionId)) return reply.status(401).send({ error: "直连授权已过期，请重新检测。" });
    reply.setCookie("ml_media", issueCookie(entry.sessionId), { path: "/api/", httpOnly: true, sameSite: "strict", secure: settings!.directOrigin.startsWith("https:"), maxAge: lifetime });
    return { connected: true };
  });
  app.get("/api/media/status", async (request, reply) => isDirect(request) ? { connected: true } : reply.status(404).send());
  for (const path of ["/api/media/probe", "/api/media/connect", "/api/media/status", "/api/tracks/:id/stream", "/api/tracks/:id/artwork"]) app.options(path, async (_, reply) => reply.status(404).send());

  return { isDirect, authorize(request: FastifyRequest, reply: FastifyReply) {
    const path = routePath(request);
    if (["/api/health", "/api/media/probe", "/api/media/connect"].includes(path)) return;
    const session = authenticate(request.cookies.ml_media);
    if (!session) return reply.status(401).send({ error: "媒体连接已失效。" });
    request.account = session.user; request.sessionId = session.sessionId;
  } };
}
