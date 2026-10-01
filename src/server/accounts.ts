import { createHash, randomBytes, randomInt, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseHandle } from "./db.js";
import type { AppConfig } from "./config.js";
import { defaultPreferences, type AccountUser, type AccountSession, type UserPreferences } from "../shared/accounts.js";
import { registerMediaConnection } from "./media-connection.js";

const scrypt = promisify(nodeScrypt);
export const sessionCookie = "ml_session";
export const sessionTtl = 14 * 24 * 60 * 60 * 1000;
const stamp = () => new Date().toISOString();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode, publicMessage: message }); }
type Row = Record<string, unknown>;
export type AccountStore = ReturnType<typeof createAccountStore>;
declare module "fastify" {
  interface FastifyInstance { accounts?: AccountStore; }
  interface FastifyRequest { account?: AccountUser; sessionId?: string; }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, expected] = encoded.split(":");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const hash = await scrypt(password, salt, 64) as Buffer;
  const target = Buffer.from(expected, "hex");
  return hash.length === target.length && timingSafeEqual(hash, target);
}
function validatePassword(password: string) {
  if (typeof password !== "string" || [...password].length < 8 || [...password].length > 64 || !password.trim()) fail("密码需为 8–64 个字符，不能全部为空格。");
}
function text(value: unknown, label: string, max: number, optional = false): string {
  if (typeof value !== "string" || (!optional && !value.trim()) || [...value].length > max) fail(`${label}格式不正确，请检查后重试。`);
  return (value as string).trim();
}
function toUser(row: Row): AccountUser {
  return { id: String(row.id), username: String(row.username), displayName: String(row.display_name), bio: String(row.bio), role: row.role as AccountUser["role"], status: row.status as AccountUser["status"], color: row.color as AccountUser["color"], joined: String(row.created_at), lastSeen: row.last_seen ? String(row.last_seen) : "尚未登录", passwordUpdated: String(row.password_updated_at), mustChangePassword: Boolean(row.must_change_password) };
}
export function temporaryPassword(): string {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%&*+-_=?"];
  const alphabet = groups.join("");
  const result = groups.map((group) => group[randomInt(group.length)]);
  const length = randomInt(12, 23);
  while (result.length < length) result.push(alphabet[randomInt(alphabet.length)]);
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result.join("");
}

export function createAccountStore(database: DatabaseHandle, config: AppConfig) {
  const db = database.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, display_name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL CHECK(role IN ('admin','member')), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
      color TEXT NOT NULL DEFAULT 'rose', must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_seen TEXT, password_updated_at TEXT NOT NULL,
      preferences TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, created_at TEXT NOT NULL, last_seen TEXT NOT NULL, user_agent TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
  const failures = new Map<string, { count: number; until: number }>();
  const find = (id: string) => db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
  const requireAdmin = (actor: AccountUser) => { const current = find(actor.id); if (!current || current.role !== "admin" || current.status !== "active" || current.must_change_password) fail("只有管理员可以管理账号。", 403); };
  return {
    async initialize() {
      if (find("admin")) return;
      const passwordHash = await hashPassword(config.adminPassword);
      db.prepare("INSERT OR IGNORE INTO users(id, username, password_hash, display_name, role, created_at, password_updated_at) VALUES ('admin','admin',?,'管理员','admin',?,?)").run(passwordHash, stamp(), stamp());
    },
    async login(username: string, password: string, ip: string) {
      const key = `${ip}:${username.toLowerCase()}`;
      const ipKey = `ip:${ip}`;
      for (const entry of [key, ipKey]) { const failure = failures.get(entry); if (failure && failure.until > Date.now() && failure.count >= (entry === ipKey ? 30 : 10)) fail("尝试次数过多，请稍后再试。", 429); }
      // Reserve attempts before the asynchronous hash; parallel attempts count too.
      for (const [entry, failure] of failures) if (failure.until <= Date.now()) failures.delete(entry);
      if (failures.size >= 10000 && !failures.has(ipKey)) fail("尝试次数过多，请稍后再试。", 429);
      for (const entry of [key, ipKey]) { const previous = failures.get(entry); failures.set(entry, { count: (previous?.count ?? 0) + 1, until: Date.now() + 15 * 60_000 }); }
      const row = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as Row | undefined;
      // Do the same expensive work for an unknown username.
      const valid = await verifyPassword(password, String(row?.password_hash ?? find("admin")?.password_hash ?? ""));
      if (!row || !valid) {
        fail("用户名或密码不正确，请重新输入。", 401);
      }
      const current = find(String(row.id));
      if (!current || current.password_hash !== row.password_hash) fail("登录凭据已更新，请重新登录。", 401);
      if (current.status !== "active") fail("这个账号已停用，请联系音乐室管理员。", 403);
      failures.delete(key);
      return toUser(current);
    },
    createSession(userId: string, userAgent: string) {
      const token = randomBytes(32).toString("base64url");
      const id = randomBytes(16).toString("hex");
      db.transaction(() => {
        db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
        db.prepare("INSERT INTO sessions(id,token_hash,user_id,expires_at,created_at,last_seen,user_agent) VALUES (?,?,?,?,?,?,?)").run(id, digest(`${config.cookieSecret}:${token}`), userId, Date.now() + sessionTtl, stamp(), stamp(), userAgent.slice(0, 512));
        db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(stamp(), userId);
      })();
      return token;
    },
    authenticate(token: string | undefined) {
      if (!token || token.length > 256) return null;
      const row = db.prepare("SELECT s.id AS session_id, s.last_seen AS session_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'").get(digest(`${config.cookieSecret}:${token}`), Date.now()) as Row | undefined;
      if (!row) return null;
      if (Date.now() - Date.parse(String(row.session_seen)) > 5 * 60_000) {
        db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").run(stamp(), row.session_id);
        db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(stamp(), row.id);
      }
      return { user: toUser(row), sessionId: String(row.session_id) };
    },
    mediaSession(id: string) {
      const row = db.prepare("SELECT s.id AS session_id, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.status = 'active' AND u.must_change_password = 0").get(id, Date.now()) as Row | undefined;
      return row ? { user: toUser(row), sessionId: String(row.session_id) } : null;
    },
    user(id: string) { const row = find(id); return row ? toUser(row) : null; },
    list(actor: AccountUser) { requireAdmin(actor); return (db.prepare("SELECT * FROM users ORDER BY created_at, id").all() as Row[]).map(toUser); },
    preferences(id: string): UserPreferences {
      let saved: Partial<UserPreferences> = {};
      try { saved = JSON.parse(String(find(id)?.preferences ?? "{}")); } catch { /* Repair invalid legacy preferences through defaults. */ }
      return { ...defaultPreferences, ...saved };
    },
    savePreferences(id: string, preferences: Partial<UserPreferences>) {
      const next = { ...this.preferences(id), ...preferences };
      db.prepare("UPDATE users SET preferences = ? WHERE id = ?").run(JSON.stringify(next), id);
      return next;
    },
    profile(id: string, body: { displayName: string; bio: string; color: string }) {
      const displayName = text(body.displayName, "昵称", 24);
      const bio = text(body.bio, "个人介绍", 80, true);
      if (!["rose", "sage", "blue"].includes(body.color)) fail("请选择有效的头像颜色。");
      db.prepare("UPDATE users SET display_name = ?, bio = ?, color = ? WHERE id = ?").run(displayName, bio, body.color, id);
      return this.user(id)!;
    },
    async create(actor: AccountUser, body: { username: string; displayName: string; role: string; grantConfirmed?: boolean }) {
      requireAdmin(actor);
      const username = text(body.username, "用户名", 24).toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{1,23}$/.test(username)) fail("用户名需为 2–24 个英文、数字或 . _ - 字符，并以英文或数字开头。");
      const displayName = text(body.displayName, "昵称", 24);
      if (!["admin", "member"].includes(body.role)) fail("请选择有效的账号角色。");
      if (body.role === "admin" && !body.grantConfirmed) fail("请确认授予管理员权限。");
      const password = temporaryPassword();
      const encoded = await hashPassword(password);
      requireAdmin(actor);
      const id = randomBytes(16).toString("hex");
      if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) fail("这个用户名已被使用，请换一个。", 409);
      db.prepare("INSERT INTO users(id,username,password_hash,display_name,role,color,must_change_password,created_at,password_updated_at) VALUES (?,?,?,?,?,'blue',1,?,?)").run(id, username, encoded, displayName, body.role, stamp(), stamp());
      return { user: this.user(id)!, temporaryPassword: password };
    },
    update(actor: AccountUser, id: string, body: { displayName?: string; role?: string; status?: string; grantConfirmed?: boolean }) {
      requireAdmin(actor);
      return db.transaction(() => {
        const target = this.user(id) ?? fail("这个账号不存在。", 404);
        const role = body.role ?? target.role;
        const status = body.status ?? target.status;
        if (!["admin", "member"].includes(role) || !["active", "disabled"].includes(status)) fail("账号角色或状态无效。");
        if (role === "admin" && target.role !== "admin" && !body.grantConfirmed) fail("请确认授予管理员权限。");
        if (actor.id === id && (role !== actor.role || status !== "active")) fail("不能修改自己的角色或停用自己的账号，请由另一位管理员操作。");
        if (target.role === "admin" && target.status === "active" && (role !== "admin" || status !== "active")) {
          const count = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'").get() as { count: number };
          if (count.count <= 1) fail("音乐室至少需要保留一位可用的管理员。");
        }
        const displayName = body.displayName === undefined ? target.displayName : text(body.displayName, "昵称", 24);
        db.prepare("UPDATE users SET display_name = ?, role = ?, status = ? WHERE id = ?").run(displayName, role, status, id);
        if (status === "disabled" || role !== target.role) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
        return this.user(id)!;
      }).immediate();
    },
    async password(user: AccountUser, currentPassword: string, nextPassword: string, keepCurrentSession?: string) {
      validatePassword(nextPassword);
      const row = find(user.id) ?? fail("账号不存在。", 404);
      const beforeHash = String(row.password_hash);
      if (!await verifyPassword(currentPassword, beforeHash)) fail("当前密码不正确，请重新输入。");
      if (currentPassword === nextPassword) fail("新密码不能与当前密码相同。");
      const encoded = await hashPassword(nextPassword);
      db.transaction(() => {
        const result = db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, password_updated_at = ? WHERE id = ? AND password_hash = ? AND status = 'active'").run(encoded, stamp(), user.id, beforeHash);
        if (!result.changes) fail("密码已发生变化，请重新登录。", 409);
        db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(user.id, keepCurrentSession ?? "");
      })();
      return this.user(user.id)!;
    },
    async reset(actor: AccountUser, id: string, password: string) {
      requireAdmin(actor);
      if (actor.id === id) fail("请在登录与安全页面修改自己的密码。");
      if (!this.user(id)) fail("这个账号不存在。", 404);
      validatePassword(password);
      const encoded = await hashPassword(password);
      requireAdmin(actor);
      db.transaction(() => {
        db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, password_updated_at = ? WHERE id = ?").run(encoded, stamp(), id);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      })();
      return this.user(id)!;
    },
    sessions(userId: string, current: string): AccountSession[] {
      return (db.prepare("SELECT id, last_seen, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC").all(userId, Date.now()) as Row[]).map((row) => {
        const ua = String(row.user_agent);
        const mobile = /Mobile|Android|iPhone/i.test(ua);
        const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "浏览器";
        const browser = /Edg/.test(ua) ? "Edge" : /Firefox/.test(ua) ? "Firefox" : /Chrome|CriOS/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Web";
        return { id: String(row.id), name: row.id === current ? "此浏览器" : `${device} · ${browser}`, detail: row.id === current ? "当前音乐室会话" : mobile ? "移动设备" : "桌面设备", lastSeen: String(row.last_seen), current: row.id === current, mobile };
      });
    },
    revoke(userId: string, ids: string[]) {
      db.transaction(() => { for (const id of ids) db.prepare("DELETE FROM sessions WHERE user_id = ? AND id = ?").run(userId, id); })();
    }
  };
}

export async function registerAccountAuthentication(app: FastifyInstance, config: AppConfig, database: DatabaseHandle) {
  const accounts = createAccountStore(database, config);
  await accounts.initialize();
  app.decorate("accounts", accounts);
  const media = registerMediaConnection(app, config, accounts);
  app.addHook("preHandler", async (request, reply) => {
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0];
    if (route !== "/api" && !route.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    if (media.isDirect(request)) return media.authorize(request, reply);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.origin;
      let foreignOrigin = false;
      if (origin) { try { foreignOrigin = new URL(origin).host !== request.headers.host; } catch { foreignOrigin = true; } }
      if (foreignOrigin || request.headers["sec-fetch-site"] === "cross-site") return reply.status(403).send({ error: "请求来源不受信任，请从音乐室页面重试。" });
    }
    if (route === "/api/health" || route === "/api/auth/login") return;
    const session = accounts.authenticate(request.cookies[sessionCookie]);
    if (!session) return reply.status(401).send({ error: "登录已过期，请重新登录。" });
    request.account = session.user;
    request.sessionId = session.sessionId;
    if (session.user.mustChangePassword && !["/api/me", "/api/auth/password", "/api/auth/logout"].includes(route)) return reply.status(403).send({ error: "请先设置自己的登录密码。", code: "PASSWORD_CHANGE_REQUIRED" });
    const administrative = route.startsWith("/api/admin/") || route.startsWith("/api/directories") || (route.startsWith("/api/scan") && request.method !== "GET");
    if (administrative && session.user.role !== "admin") return reply.status(403).send({ error: "这项操作需要管理员权限。" });
  });
}
export const currentUserId = (request: FastifyRequest) => request.account?.id ?? "admin";
