import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyError, FastifyInstance } from "fastify";
import type { AlbumMetadataValues, PageOptions, ScanOptions, TrackPageOptions } from "../shared/types.js";
import type { AppConfig } from "./config.js";
import type { DatabaseHandle } from "./db.js";
import type { Scanner } from "./scanner.js";
import { clearSession, isPasswordValid, setSession } from "./auth.js";
import { currentUserId, sessionCookie, sessionTtl } from "./accounts.js";
import { createDirectoryStore } from "./directories.js";
import { registerAccountRoutes } from "./account-routes.js";
import { directMimeType, shouldTranscode } from "./audio.js";
import { safeRealPath } from "./pathSafety.js";
import { lookupLyrics, metadataStatus } from "./metadata.js";
import { LyricsLookupError } from "./lyrics-provider.js";
import { readLyricsDocument, type LyricsDocument } from "./lyrics-document.js";
import { sendFileRange, sendTranscodedStream } from "./media.js";
import { createAlbumMetadataLookup } from "./album-metadata.js";
import { MetadataLookupError } from "./musicbrainz.js";
import { createAlbumEnricher } from "./album-enrichment.js";
import { createArtworkStore, matchesArtworkEtag } from "./artwork.js";
import { artworkSizes, type ArtworkSize } from "../shared/artwork.js";
import { createLightingStore, LightingError } from "./lighting.js";

interface Dependencies {
  config: AppConfig;
  database: DatabaseHandle;
  scanner: Scanner;
}

function notFound(): { error: string } {
  return { error: "未找到资源" };
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

interface BodyTypeSchema {
  type?: string | string[];
  properties?: Record<string, BodyTypeSchema>;
  items?: BodyTypeSchema;
}

function hasStrictBodyTypes(value: unknown, schema: BodyTypeSchema): boolean {
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.includes(actual) && !(types.includes("integer") && typeof value === "number" && Number.isInteger(value))) return false;
  }
  if (Array.isArray(value) && schema.items) {
    return value.every((item) => hasStrictBodyTypes(item, schema.items!));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).every(([name, item]) => !schema.properties?.[name] || hasStrictBodyTypes(item, schema.properties[name]));
  }
  return true;
}

const searchProperties = { q: { type: "string", maxLength: 512 } };
const limitProperty = { type: "integer", minimum: 1, maximum: 500 };
const idProperty = { type: "string", minLength: 1, maxLength: 128 };
const pageProperties = {
  ...searchProperties,
  limit: limitProperty,
  offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  page: { type: "boolean" }
};

export async function registerRoutes(app: FastifyInstance, deps: Dependencies): Promise<void> {
  const { config, database, scanner } = deps;
  const readArtwork = createArtworkStore(config);
  const lighting = createLightingStore(config);
  app.addHook("preClose", async () => { lighting.close(); });
  let closing = false;
  const lookupAlbumMetadata = createAlbumMetadataLookup(config, database, undefined, () => !closing);
  const directories = createDirectoryStore(config, database);
  if (app.accounts) await directories.initialize();
  const enrichment = createAlbumEnricher(config, database, scanner, lookupAlbumMetadata,
    (error) => app.log.warn({ err: error }, "Background album metadata lookup failed"));
  app.addHook("onReady", async () => { enrichment.start(); });
  app.addHook("preClose", async () => { closing = true; enrichment.stop(); });
  const userDb = (request: import("fastify").FastifyRequest) => database.forUser(currentUserId(request));

  app.addHook("preValidation", async (request, reply) => {
    const schema = request.routeOptions.schema?.body as BodyTypeSchema | undefined;
    if (schema?.type !== "object") return;
    // Existing clients start the default scan without a request body.
    if (request.routeOptions.url === "/api/scan" && request.body === undefined) request.body = {};
    // Validate nested values too, before AJV turns numeric track IDs into strings.
    if (!hasStrictBodyTypes(request.body, schema)) {
      return reply.status(400).send({ error: "请求参数不正确，请检查后重试" });
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    // Query coercion can produce Infinity; it must not reach SQLite or FFmpeg.
    const values = Object.values((request.query ?? {}) as Record<string, unknown>);
    if (values.some((value) => typeof value === "number" && !Number.isFinite(value))) {
      return reply.status(400).send({ error: "请求参数不正确，请检查后重试" });
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if ("publicMessage" in error && typeof error.publicMessage === "string" && error.statusCode && error.statusCode >= 400 && error.statusCode < 500) return reply.status(error.statusCode).send({ error: error.publicMessage });
    if (error.validation) return reply.status(400).send({ error: "请求参数不正确，请检查后重试" });
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return reply.status(404).send({ error: "文件不存在，请确认曲库已挂载" });
    }
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) request.log.error({ err: error }, "API request failed");
    return reply.status(status).send({ error: status === 500 ? "服务暂时不可用，请稍后重试" : "请求无效，请检查后重试" });
  });

  if (app.accounts) await registerAccountRoutes(app);

  app.get("/api/health", async () => ({ ok: true }));

  app.post<{ Body: { password: string; username?: string } }>("/api/auth/login", {
    schema: { body: objectSchema({ username: { type: "string", minLength: 2, maxLength: 24 }, password: { type: "string", minLength: 1, maxLength: 1024 } }, ["password"]) }
  }, async (request, reply) => {
    const password = request.body?.password ?? "";
    if (app.accounts) {
      const user = await app.accounts.login(request.body.username?.trim() ?? "admin", password, request.ip);
      const token = app.accounts.createSession(user.id, request.headers["user-agent"] ?? "");
      reply.setCookie(sessionCookie, token, { httpOnly: true, sameSite: "lax", secure: config.cookieSecure ?? config.isProduction, path: "/", maxAge: sessionTtl / 1000 });
      return { ok: true, user };
    }
    if (!isPasswordValid(request, config, password)) {
      return reply.status(401).send({ error: "密码错误" });
    }
    setSession(reply, config);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (request.account && request.sessionId) app.accounts?.revoke(request.account.id, [request.sessionId]);
    clearSession(reply);
    return { ok: true };
  });

  app.get("/api/me", async (request) => request.account && app.accounts ? {
    user: request.account,
    preferences: app.accounts.preferences(request.account.id),
    directory: await directories.state(request.account.role === "admin")
  } : { user: { name: "admin" }, config: { libraryPath: config.musicLibraryPath, onlineMetadata: config.enableOnlineMetadata } });

  app.get("/api/summary", async (request) => userDb(request).summary());
  app.get("/api/catalog/status", async () => ({ revision: database.catalogRevision(), scanRunning: scanner.isRunning(), enrichment: enrichment.status() }));
  app.get<{ Params: { key: string } }>("/api/admin/albums/:key/metadata", async (request, reply) => {
    const metadata = database.getAlbumMetadata(request.params.key);
    return metadata ? { ...metadata, onlineLookupEnabled: config.enableOnlineMetadata, autoCompleteEnabled: enrichment.status().enabled } : reply.status(404).send(notFound());
  });
  app.post<{ Params: { key: string }; Body: { revision: string } }>("/api/admin/albums/:key/metadata/lookup", {
    schema: { body: objectSchema({ revision: { type: "string", pattern: "^[a-f0-9]{64}$" } }, ["revision"]) }
  }, async (request, reply) => {
    const metadata = database.getAlbumMetadata(request.params.key);
    if (!metadata) return reply.status(404).send(notFound());
    if (metadata.revision !== request.body.revision) return reply.status(409).send({ error: "专辑信息已更新，请重新载入后再查询。" });
    try {
      const result = await lookupAlbumMetadata(metadata.album);
      if (database.getAlbumMetadata(request.params.key)?.revision !== metadata.revision) return reply.status(409).send({ error: "专辑信息已更新，请重新载入后再查询。" });
      return result;
    } catch (error) {
      if (error instanceof MetadataLookupError) return reply.status(error.statusCode).send({ error: error.publicMessage });
      throw error;
    }
  });
  app.put<{ Params: { key: string }; Body: AlbumMetadataValues & { revision: string } }>("/api/admin/albums/:key/metadata", {
    schema: { body: objectSchema({
      year: { type: ["integer", "null"], minimum: 1000, maximum: 9999 },
      genre: { type: ["string", "null"], maxLength: 80, pattern: "^[^\\u0000-\\u001f\\u007f]*$" },
      revision: { type: "string", pattern: "^[a-f0-9]{64}$" }
    }, ["year", "genre", "revision"]) }
  }, async (request, reply) => {
    const result = database.saveAlbumMetadata(request.params.key, request.body, request.body.revision);
    if (result.status === "not_found") return reply.status(404).send(notFound());
    if (result.status === "conflict") return reply.status(409).send({ error: "专辑信息已更新，请重新载入后再保存。" });
    return { ...result.metadata, onlineLookupEnabled: config.enableOnlineMetadata, autoCompleteEnabled: enrichment.status().enabled };
  });
  app.get<{ Querystring: { path?: string } }>("/api/directories", {
    schema: { querystring: objectSchema({ path: { type: "string", minLength: 1, maxLength: 4096 } }) }
  }, async (request) => directories.state(true, request.query.path));
  let selectingDirectory = false;
  app.put<{ Body: { path: string } }>("/api/directories", {
    schema: { body: objectSchema({ path: { type: "string", minLength: 1, maxLength: 4096 } }, ["path"]) }
  }, async (request, reply) => {
    if (selectingDirectory || scanner.isRunning()) return reply.status(409).send({ error: "扫描正在进行，请等待完成后再更换目录。" });
    selectingDirectory = true;
    try {
      const directory = await directories.select(request.body.path);
      void scanner.scan().catch((error) => request.log.error({ err: error }, "Scan failed"));
      return { directory, scan: database.latestScan() };
    } finally { selectingDirectory = false; }
  });
  app.post("/api/scan/stop", async () => { scanner.stop?.(); return database.latestScan(); });

  app.post<{ Body: ScanOptions }>("/api/scan", {
    schema: { body: objectSchema({ force: { type: "boolean" }, prune: { type: "boolean" } }) }
  }, async (request, reply) => {
    if (selectingDirectory || scanner.isRunning()) {
      return reply.status(409).send({ error: "扫描已在运行" });
    }
    void scanner.scan(request.body).catch((error) => request.log.error({ err: error }, "Scan failed"));
    return database.latestScan();
  });

  app.get("/api/scan", async () => database.latestScan());

  app.get<{ Querystring: TrackPageOptions & { page?: boolean } }>("/api/tracks", {
    schema: { querystring: objectSchema({
      ...pageProperties,
      favorite: { type: "boolean" }
    }) }
  }, async (request) => {
    return request.query.page ? userDb(request).pageTracks(request.query) : userDb(request).listTracks(request.query);
  });

  app.get<{ Params: { id: string } }>("/api/tracks/:id", async (request, reply) => {
    const track = userDb(request).getTrack(request.params.id);
    if (!track) return reply.status(404).send(notFound());
    return track;
  });

  app.get<{ Params: { id: string } }>("/api/tracks/:id/lighting", {
    preValidation: async (request, reply) => {
      if (Object.keys(request.query ?? {}).length) return reply.status(400).send({ error: "灯光编排不接受查询参数" });
    },
    schema: { params: objectSchema({ id: idProperty }, ["id"]), querystring: objectSchema({}) }
  }, async (request, reply) => {
    const track = userDb(request).getTrack(request.params.id);
    if (!track) return reply.status(404).send(notFound());
    reply.header("Cache-Control", "private, no-store");
    try { return { program: await lighting.read({ path: track.path, duration: track.duration ?? 0 }) }; }
    catch (error) {
      const status = error instanceof LightingError ? error.statusCode : 503;
      return reply.status(status).send({ error: "本曲灯光分析暂未完成，灯光正实时跟随声音。" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/tracks/:id/availability", async (request, reply) => {
    const track = userDb(request).getTrack(request.params.id);
    if (!track) return reply.status(404).send(notFound());
    try {
      const file = safeRealPath(config.musicLibraryPath, track.path);
      await fs.promises.access(file, fs.constants.R_OK);
      if (!(await fs.promises.stat(file)).isFile()) throw new Error("Not an audio file");
      return { available: true };
    } catch { return reply.status(404).send({ error: "音乐文件不可访问，请检查目录挂载和文件权限。" }); }
  });

  app.patch<{ Params: { id: string }; Body: { favorite: boolean } }>("/api/tracks/:id/favorite", {
    schema: { body: objectSchema({ favorite: { type: "boolean" } }, ["favorite"]) }
  }, async (request, reply) => {
    const track = userDb(request).toggleFavorite(request.params.id, request.body.favorite);
    if (!track) return reply.status(404).send(notFound());
    return track;
  });

  app.get<{ Params: { id: string }; Querystring: { size?: ArtworkSize } }>("/api/tracks/:id/artwork", {
    schema: { querystring: objectSchema({ size: { type: "integer", enum: [...artworkSizes] } }) }
  }, async (request, reply) => {
    if (!userDb(request).getTrack(request.params.id)) return reply.status(404).send(notFound());
    const row = database.db.prepare("SELECT artwork_path FROM tracks WHERE id = ?").get(request.params.id) as { artwork_path?: string } | undefined;
    if (!row?.artwork_path) return reply.status(404).send(notFound());
    const artworkPath = row.artwork_path.startsWith(config.artworkDir)
      ? safeRealPath(config.artworkDir, row.artwork_path)
      : safeRealPath(config.musicLibraryPath, row.artwork_path);
    const image = await readArtwork(artworkPath, request.query.size);
    reply.type(image.type).header("Cache-Control", "private, no-cache").header("ETag", image.etag);
    if (matchesArtworkEtag(request.headers["if-none-match"], image.etag)) return reply.status(304).send();
    reply.header("Content-Length", image.bytes);
    return reply.send(fs.createReadStream(image.file));
  });

  app.get<{ Params: { id: string }; Querystring: { search?: string; format?: string } }>("/api/tracks/:id/lyrics", async (request, reply) => {
    const track = userDb(request).getTrack(request.params.id);
    if (!track) return reply.status(404).send(notFound());

    let lyricsPath = database.getTrackLyricsPath(track.id);
    const shouldSearch = request.query.search === "1" || request.query.search === "true";
    let existingLyrics: LyricsDocument | null = null;
    if (lyricsPath) {
      try {
        const safePath = safeRealPath(lyricsPath.startsWith(config.metadataDir) ? config.metadataDir : config.musicLibraryPath, lyricsPath);
        existingLyrics = readLyricsDocument(await fsp.readFile(safePath, "utf8"), safePath.endsWith(".lyrics.json"));
        if (!existingLyrics) lyricsPath = null;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        lyricsPath = null;
      }
    }
    const canRefreshOnlineLyrics = !lyricsPath || lyricsPath.startsWith(config.metadataDir);
    const upgradeKey = `lyrics-timing-upgrade:${track.id}`;
    const upgrade = database.getMetadataCache(upgradeKey) as { retryAt?: number } | null;
    const needsUpgrade = request.query.format === "json" && lyricsPath && canRefreshOnlineLyrics
      && !lyricsPath.endsWith(".lyrics.json") && (upgrade?.retryAt ?? 0) <= Date.now();
    if ((shouldSearch || !lyricsPath || needsUpgrade) && config.enableOnlineMetadata && canRefreshOnlineLyrics) {
      // Older online caches only contain LRC. Upgrade lazily; an outage must neither
      // erase usable lyrics nor cause another provider request on every panel open.
      if (needsUpgrade) database.setMetadataCache(upgradeKey, "LRCLIB", { retryAt: Date.now() + 24 * 60 * 60 * 1000 });
      try {
        const onlineLyricsPath = await lookupLyrics(config, track, database, undefined, { refresh: shouldSearch });
        if (onlineLyricsPath) {
          existingLyrics = readLyricsDocument(await fsp.readFile(safeRealPath(config.metadataDir, onlineLyricsPath), "utf8"), onlineLyricsPath.endsWith(".lyrics.json")) ?? existingLyrics;
          database.setTrackLyricsPath(track.id, onlineLyricsPath);
        }
      } catch (error) {
        if (!(error instanceof LyricsLookupError)) throw error;
        // Keep a usable cached lyric during an outage, without reporting a false empty result.
        if (existingLyrics === null) {
          if (error.retryAfter) reply.header("Retry-After", String(error.retryAfter));
          return reply.status(503).send({ error: error.message });
        }
      }
    }

    if (existingLyrics === null) return reply.status(404).send(notFound());
    if (request.query.format === "json") return { lines: existingLyrics.lines };
    reply.type("text/plain; charset=utf-8");
    return existingLyrics.text;
  });

  app.get<{ Params: { id: string }; Querystring: { mode?: "auto" | "direct" | "transcode"; start?: number } }>("/api/tracks/:id/stream", {
    schema: { querystring: objectSchema({
      mode: { type: "string", enum: ["auto", "direct", "transcode"] },
      start: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
    }) }
  }, async (request, reply) => {
    const track = userDb(request).getTrack(request.params.id);
    if (!track) return reply.status(404).send(notFound());
    const filePath = safeRealPath(config.musicLibraryPath, track.path);
    const mode = request.query.mode ?? "auto";
    const start = request.query.start ?? 0;
    const directMime = directMimeType(track);
    const transcode = mode === "transcode" || (mode === "auto" && shouldTranscode(track));

    if (!transcode) {
      if (!directMime) return reply.status(415).send({ error: "此音频格式需要转码，请使用自动播放模式" });
      return sendFileRange(request.headers.range, reply, filePath, directMime);
    }

    return sendTranscodedStream(request, reply, filePath, start);
  });

  app.get<{ Querystring: { q?: string } }>("/api/search", {
    schema: { querystring: objectSchema(searchProperties) }
  }, async (request) => {
    const q = request.query.q?.trim();
    if (!q) return { tracks: [], albums: [], artists: [] };
    return userDb(request).search(q);
  });

  app.get<{ Querystring: PageOptions & { page?: boolean } }>("/api/albums", {
    schema: { querystring: objectSchema(pageProperties) }
  }, async (request) => {
    const page = database.pageAlbums(request.query);
    return request.query.page ? page : page.items;
  });

  app.get<{ Params: { key: string } }>("/api/albums/:key", async (request, reply) => {
    const album = userDb(request).getAlbum(request.params.key);
    if (!album) return reply.status(404).send(notFound());
    return album;
  });

  app.get<{ Querystring: PageOptions & { page?: boolean } }>("/api/artists", {
    schema: { querystring: objectSchema(pageProperties) }
  }, async (request) => {
    const page = database.pageArtists(request.query);
    return request.query.page ? page : page.items;
  });

  app.get<{ Params: { name: string } }>("/api/artists/:name", async (request, reply) => {
    const artist = userDb(request).getArtist(request.params.name);
    if (!artist) return reply.status(404).send(notFound());
    return artist;
  });

  app.get("/api/playlists", async (request) => userDb(request).listPlaylists());

  database.db.exec("CREATE TABLE IF NOT EXISTS playlist_requests (user_id TEXT NOT NULL, request_id TEXT NOT NULL, playlist_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (user_id, request_id))");
  app.post<{ Body: { name: string; description?: string | null; requestId?: string } }>("/api/playlists", {
    schema: { body: objectSchema({
      name: { type: "string", minLength: 1 },
      description: { type: ["string", "null"], maxLength: 2000 },
      requestId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9_-]+$" }
    }, ["name"]) }
  }, async (request, reply) => {
    const name = request.body?.name?.trim();
    if (!name) return reply.status(400).send({ error: "歌单名称不能为空" });
    if ([...name].length > 200) return reply.status(400).send({ error: "歌单名称不能超过 200 个字符" });
    const description = request.body.description ?? null;
    const requestId = request.body.requestId;
    if (!requestId) return userDb(request).createPlaylist(name, description);
    const userId = currentUserId(request);
    const payload = JSON.stringify({ name, description });
    return database.db.transaction(() => {
      const prior = database.db.prepare("SELECT playlist_id, payload FROM playlist_requests WHERE user_id = ? AND request_id = ?").get(userId, requestId) as { playlist_id: string; payload: string } | undefined;
      if (prior) {
        const result = userDb(request).getPlaylist(prior.playlist_id);
        if (!result || prior.payload !== payload) return reply.status(409).send({ error: "创建请求已发生变化，请关闭弹窗后重新创建。" });
        return result.playlist;
      }
      const playlist = userDb(request).createPlaylist(name, description);
      database.db.prepare("INSERT INTO playlist_requests(user_id,request_id,playlist_id,payload) VALUES (?,?,?,?)").run(userId, requestId, playlist.id, payload);
      return playlist;
    })();
  });

  app.get<{ Params: { id: string } }>("/api/playlists/:id", async (request, reply) => {
    const playlist = userDb(request).getPlaylist(request.params.id);
    if (!playlist) return reply.status(404).send(notFound());
    return playlist;
  });

  app.patch<{ Params: { id: string }; Body: { name: string } }>("/api/playlists/:id", {
    schema: { body: objectSchema({ name: { type: "string", minLength: 1 } }, ["name"]) }
  }, async (request, reply) => {
    const name = request.body.name.trim();
    if (!name) return reply.status(400).send({ error: "歌单名称不能为空" });
    if ([...name].length > 200) return reply.status(400).send({ error: "歌单名称不能超过 200 个字符" });
    const playlist = userDb(request).renamePlaylist(request.params.id, name);
    if (!playlist) return reply.status(404).send(notFound());
    return playlist;
  });

  app.delete<{ Params: { id: string } }>("/api/playlists/:id", async (request, reply) => {
    if (!userDb(request).deletePlaylist(request.params.id)) return reply.status(404).send(notFound());
    return { ok: true };
  });

  app.put<{ Params: { id: string }; Body: { trackIds: string[]; revision: string } }>("/api/playlists/:id/tracks/order", {
    schema: { body: objectSchema({
      trackIds: { type: "array", items: idProperty, uniqueItems: true },
      revision: { type: "string", minLength: 1, maxLength: 128 }
    }, ["trackIds", "revision"]) }
  }, async (request, reply) => {
    const result = userDb(request).reorderPlaylistTracks(request.params.id, request.body.trackIds, request.body.revision);
    if (result.status === "not_found") return reply.status(404).send(notFound());
    if (result.status === "conflict") {
      return reply.status(409).send({ error: "歌单已发生变化，请刷新后重新排序" });
    }
    return result.detail;
  });

  app.post<{ Params: { id: string }; Body: { trackId: string } }>("/api/playlists/:id/tracks", {
    schema: { body: objectSchema({ trackId: idProperty }, ["trackId"]) }
  }, async (request, reply) => {
    const detail = userDb(request).addTrackToPlaylist(request.params.id, request.body.trackId);
    if (!detail) return reply.status(404).send(notFound());
    return detail;
  });

  app.delete<{ Params: { id: string; trackId: string } }>("/api/playlists/:id/tracks/:trackId", async (request, reply) => {
    const detail = userDb(request).removeTrackFromPlaylist(request.params.id, request.params.trackId);
    if (!detail) return reply.status(404).send(notFound());
    return { ok: true, ...detail };
  });

  app.get<{ Querystring: { scanId?: string; limit?: number } }>("/api/scan/errors", {
    schema: { querystring: objectSchema({ scanId: idProperty, limit: limitProperty }) }
  }, async (request) => {
    return database.listScanErrors(request.query.scanId, request.query.limit);
  });

  app.get("/api/metadata/status", async () => metadataStatus(config, database));

  if (!config.isProduction) {
    app.get("/*", async (_request, reply) => {
      return reply.status(404).send({ error: "前端开发服务运行在 Vite 上" });
    });
  }
}
