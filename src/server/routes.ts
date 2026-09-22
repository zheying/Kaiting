import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyError, FastifyInstance } from "fastify";
import type { PageOptions, ScanOptions, TrackPageOptions } from "../shared/types.js";
import type { AppConfig } from "./config.js";
import type { DatabaseHandle } from "./db.js";
import type { Scanner } from "./scanner.js";
import { clearSession, isPasswordValid, setSession } from "./auth.js";
import { directMimeType, shouldTranscode } from "./audio.js";
import { safeRealPath } from "./pathSafety.js";
import { lookupLyrics, metadataStatus } from "./metadata.js";
import { sendFileRange, sendTranscodedStream } from "./media.js";

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
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).includes(actual)) return false;
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
    if (error.validation) return reply.status(400).send({ error: "请求参数不正确，请检查后重试" });
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return reply.status(404).send({ error: "文件不存在，请确认曲库已挂载" });
    }
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) request.log.error({ err: error }, "API request failed");
    return reply.status(status).send({ error: status === 500 ? "服务暂时不可用，请稍后重试" : "请求无效，请检查后重试" });
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.post<{ Body: { password: string } }>("/api/auth/login", {
    schema: { body: objectSchema({ password: { type: "string", minLength: 1, maxLength: 1024 } }, ["password"]) }
  }, async (request, reply) => {
    const password = request.body?.password ?? "";
    if (!isPasswordValid(request, config, password)) {
      return reply.status(401).send({ error: "密码错误" });
    }
    setSession(reply, config);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    clearSession(reply);
    return { ok: true };
  });

  app.get("/api/me", async () => ({
    user: { name: "admin" },
    config: {
      libraryPath: config.musicLibraryPath,
      onlineMetadata: config.enableOnlineMetadata
    }
  }));

  app.get("/api/summary", async () => database.summary());

  app.post<{ Body: ScanOptions }>("/api/scan", {
    schema: { body: objectSchema({ force: { type: "boolean" }, prune: { type: "boolean" } }) }
  }, async (request, reply) => {
    if (scanner.isRunning()) {
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
    return request.query.page ? database.pageTracks(request.query) : database.listTracks(request.query);
  });

  app.get<{ Params: { id: string } }>("/api/tracks/:id", async (request, reply) => {
    const track = database.getTrack(request.params.id);
    if (!track) return reply.status(404).send(notFound());
    return track;
  });

  app.patch<{ Params: { id: string }; Body: { favorite: boolean } }>("/api/tracks/:id/favorite", {
    schema: { body: objectSchema({ favorite: { type: "boolean" } }, ["favorite"]) }
  }, async (request, reply) => {
    const track = database.toggleFavorite(request.params.id, request.body.favorite);
    if (!track) return reply.status(404).send(notFound());
    return track;
  });

  app.get<{ Params: { id: string } }>("/api/tracks/:id/artwork", async (request, reply) => {
    const row = database.db.prepare("SELECT artwork_path FROM tracks WHERE id = ?").get(request.params.id) as { artwork_path?: string } | undefined;
    if (!row?.artwork_path) return reply.status(404).send(notFound());
    const artworkPath = row.artwork_path.startsWith(config.artworkDir)
      ? safeRealPath(config.artworkDir, row.artwork_path)
      : safeRealPath(config.musicLibraryPath, row.artwork_path);
    const mimeType = artworkPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    reply.type(mimeType);
    return reply.send(fs.createReadStream(artworkPath));
  });

  app.get<{ Params: { id: string }; Querystring: { search?: string } }>("/api/tracks/:id/lyrics", async (request, reply) => {
    const track = database.getTrack(request.params.id);
    if (!track) return reply.status(404).send(notFound());

    let lyricsPath = database.getTrackLyricsPath(track.id);
    const shouldSearch = request.query.search === "1" || request.query.search === "true";
    const canRefreshOnlineLyrics = !lyricsPath || lyricsPath.startsWith(config.metadataDir);
    if (shouldSearch && config.enableOnlineMetadata && canRefreshOnlineLyrics) {
      const onlineLyricsPath = await lookupLyrics(config, track, database).catch(() => null);
      if (onlineLyricsPath) {
        lyricsPath = onlineLyricsPath;
        database.setTrackLyricsPath(track.id, lyricsPath);
      }
    }

    if (!lyricsPath) return reply.status(404).send(notFound());
    const safeLyricsPath = lyricsPath.startsWith(config.metadataDir)
      ? safeRealPath(config.metadataDir, lyricsPath)
      : safeRealPath(config.musicLibraryPath, lyricsPath);
    reply.type("text/plain; charset=utf-8");
    return fsp.readFile(safeLyricsPath, "utf8");
  });

  app.get<{ Params: { id: string }; Querystring: { mode?: "auto" | "direct" | "transcode"; start?: number } }>("/api/tracks/:id/stream", {
    schema: { querystring: objectSchema({
      mode: { type: "string", enum: ["auto", "direct", "transcode"] },
      start: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
    }) }
  }, async (request, reply) => {
    const track = database.getTrack(request.params.id);
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
    return database.search(q);
  });

  app.get<{ Querystring: PageOptions & { page?: boolean } }>("/api/albums", {
    schema: { querystring: objectSchema(pageProperties) }
  }, async (request) => {
    const page = database.pageAlbums(request.query);
    return request.query.page ? page : page.items;
  });

  app.get<{ Params: { key: string } }>("/api/albums/:key", async (request, reply) => {
    const album = database.getAlbum(request.params.key);
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
    const artist = database.getArtist(request.params.name);
    if (!artist) return reply.status(404).send(notFound());
    return artist;
  });

  app.get("/api/playlists", async () => database.listPlaylists());

  app.post<{ Body: { name: string; description?: string | null } }>("/api/playlists", {
    schema: { body: objectSchema({
      name: { type: "string", minLength: 1 },
      description: { type: ["string", "null"], maxLength: 2000 }
    }, ["name"]) }
  }, async (request, reply) => {
    const name = request.body?.name?.trim();
    if (!name) return reply.status(400).send({ error: "歌单名称不能为空" });
    if ([...name].length > 200) return reply.status(400).send({ error: "歌单名称不能超过 200 个字符" });
    return database.createPlaylist(name, request.body?.description ?? null);
  });

  app.get<{ Params: { id: string } }>("/api/playlists/:id", async (request, reply) => {
    const playlist = database.getPlaylist(request.params.id);
    if (!playlist) return reply.status(404).send(notFound());
    return playlist;
  });

  app.patch<{ Params: { id: string }; Body: { name: string } }>("/api/playlists/:id", {
    schema: { body: objectSchema({ name: { type: "string", minLength: 1 } }, ["name"]) }
  }, async (request, reply) => {
    const name = request.body.name.trim();
    if (!name) return reply.status(400).send({ error: "歌单名称不能为空" });
    if ([...name].length > 200) return reply.status(400).send({ error: "歌单名称不能超过 200 个字符" });
    const playlist = database.renamePlaylist(request.params.id, name);
    if (!playlist) return reply.status(404).send(notFound());
    return playlist;
  });

  app.delete<{ Params: { id: string } }>("/api/playlists/:id", async (request, reply) => {
    if (!database.deletePlaylist(request.params.id)) return reply.status(404).send(notFound());
    return { ok: true };
  });

  app.put<{ Params: { id: string }; Body: { trackIds: string[]; revision: string } }>("/api/playlists/:id/tracks/order", {
    schema: { body: objectSchema({
      trackIds: { type: "array", items: idProperty, uniqueItems: true },
      revision: { type: "string", minLength: 1, maxLength: 128 }
    }, ["trackIds", "revision"]) }
  }, async (request, reply) => {
    const result = database.reorderPlaylistTracks(request.params.id, request.body.trackIds, request.body.revision);
    if (result.status === "not_found") return reply.status(404).send(notFound());
    if (result.status === "conflict") {
      return reply.status(409).send({ error: "歌单已发生变化，请刷新后重新排序" });
    }
    return result.detail;
  });

  app.post<{ Params: { id: string }; Body: { trackId: string } }>("/api/playlists/:id/tracks", {
    schema: { body: objectSchema({ trackId: idProperty }, ["trackId"]) }
  }, async (request, reply) => {
    const detail = database.addTrackToPlaylist(request.params.id, request.body.trackId);
    if (!detail) return reply.status(404).send(notFound());
    return detail;
  });

  app.delete<{ Params: { id: string; trackId: string } }>("/api/playlists/:id/tracks/:trackId", async (request, reply) => {
    const detail = database.removeTrackFromPlaylist(request.params.id, request.params.trackId);
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
