import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { DatabaseHandle } from "./db.js";
import type { Scanner } from "./scanner.js";
import { clearSession, isPasswordValid, setSession } from "./auth.js";
import { directMimeType, shouldTranscode } from "./audio.js";
import { safeRealPath } from "./pathSafety.js";
import { lookupLyrics, metadataStatus } from "./metadata.js";

interface Dependencies {
  config: AppConfig;
  database: DatabaseHandle;
  scanner: Scanner;
}

function notFound(): { error: string } {
  return { error: "未找到资源" };
}

function sendFileRange(requestRange: string | undefined, reply: Parameters<FastifyInstance["get"]>[1] extends never ? never : any, filePath: string, mimeType: string): void {
  const stat = fs.statSync(filePath);
  const range = requestRange;
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", mimeType);

  if (!range) {
    reply.header("Content-Length", stat.size);
    reply.send(fs.createReadStream(filePath));
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    reply.status(416).send();
    return;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (start >= stat.size || end >= stat.size || start > end) {
    reply.status(416).send();
    return;
  }

  reply.status(206);
  reply.header("Content-Length", end - start + 1);
  reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  reply.send(fs.createReadStream(filePath, { start, end }));
}

export async function registerRoutes(app: FastifyInstance, deps: Dependencies): Promise<void> {
  const { config, database, scanner } = deps;

  app.get("/api/health", async () => ({ ok: true }));

  app.post<{ Body: { password?: string } }>("/api/auth/login", async (request, reply) => {
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

  app.post("/api/scan", async (_request, reply) => {
    if (scanner.isRunning()) {
      return reply.status(409).send({ error: "扫描已在运行" });
    }
    void scanner.scan();
    return database.latestScan();
  });

  app.get("/api/scan", async () => database.latestScan());

  app.get<{ Querystring: { q?: string; limit?: string; offset?: string; favorite?: string } }>("/api/tracks", async (request) => {
    return database.listTracks({
      q: request.query.q,
      limit: request.query.limit ? Number(request.query.limit) : undefined,
      offset: request.query.offset ? Number(request.query.offset) : undefined,
      favorite: request.query.favorite === "true"
    });
  });

  app.get<{ Params: { id: string } }>("/api/tracks/:id", async (request, reply) => {
    const track = database.getTrack(request.params.id);
    if (!track) return reply.status(404).send(notFound());
    return track;
  });

  app.patch<{ Params: { id: string }; Body: { favorite?: boolean } }>("/api/tracks/:id/favorite", async (request, reply) => {
    const track = database.toggleFavorite(request.params.id, Boolean(request.body?.favorite));
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

  app.get<{ Params: { id: string }; Querystring: { mode?: "auto" | "direct" | "transcode"; start?: string } }>("/api/tracks/:id/stream", async (request, reply) => {
    const track = database.getTrack(request.params.id);
    if (!track) return reply.status(404).send(notFound());
    const filePath = safeRealPath(config.musicLibraryPath, track.path);
    const mode = request.query.mode ?? "auto";
    const start = Math.max(0, Number(request.query.start ?? 0) || 0);
    const directMime = directMimeType(track);
    const transcode = mode === "transcode" || (mode === "auto" && shouldTranscode(track));

    if (!transcode && directMime) {
      return sendFileRange(request.headers.range, reply, filePath, directMime);
    }

    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      ...(start > 0 ? ["-ss", String(start)] : []),
      "-i",
      filePath,
      "-vn",
      "-map_metadata",
      "-1",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "192k",
      "-f",
      "mp3",
      "pipe:1"
    ];
    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    reply.type("audio/mpeg");
    request.raw.on("close", () => ffmpeg.kill("SIGKILL"));
    return reply.send(ffmpeg.stdout);
  });

  app.get<{ Querystring: { q?: string } }>("/api/search", async (request) => {
    const q = request.query.q?.trim();
    if (!q) return { tracks: [], albums: [], artists: [] };
    return database.search(q);
  });

  app.get("/api/albums", async () => database.listAlbums());

  app.get<{ Params: { key: string } }>("/api/albums/:key", async (request, reply) => {
    const album = database.getAlbum(decodeURIComponent(request.params.key));
    if (!album) return reply.status(404).send(notFound());
    return album;
  });

  app.get("/api/artists", async () => database.listArtists());

  app.get<{ Params: { name: string } }>("/api/artists/:name", async (request, reply) => {
    const artist = database.getArtist(decodeURIComponent(request.params.name));
    if (!artist) return reply.status(404).send(notFound());
    return artist;
  });

  app.get("/api/playlists", async () => database.listPlaylists());

  app.post<{ Body: { name?: string; description?: string } }>("/api/playlists", async (request, reply) => {
    const name = request.body?.name?.trim();
    if (!name) return reply.status(400).send({ error: "歌单名称不能为空" });
    return database.createPlaylist(name, request.body?.description ?? null);
  });

  app.get<{ Params: { id: string } }>("/api/playlists/:id", async (request, reply) => {
    const playlist = database.getPlaylist(request.params.id);
    if (!playlist) return reply.status(404).send(notFound());
    return playlist;
  });

  app.post<{ Params: { id: string }; Body: { trackId?: string } }>("/api/playlists/:id/tracks", async (request, reply) => {
    const trackId = request.body?.trackId;
    if (!trackId || !database.getTrack(trackId)) return reply.status(404).send(notFound());
    database.addTrackToPlaylist(request.params.id, trackId);
    return database.getPlaylist(request.params.id);
  });

  app.delete<{ Params: { id: string; trackId: string } }>("/api/playlists/:id/tracks/:trackId", async (request) => {
    database.removeTrackFromPlaylist(request.params.id, request.params.trackId);
    return { ok: true };
  });

  app.get<{ Querystring: { scanId?: string; limit?: string } }>("/api/scan/errors", async (request) => {
    return database.listScanErrors(request.query.scanId, request.query.limit ? Number(request.query.limit) : undefined);
  });

  app.get("/api/metadata/status", async () => metadataStatus(config, database));

  if (!config.isProduction) {
    app.get("/*", async (_request, reply) => {
    return reply.status(404).send({ error: "前端开发服务运行在 Vite 上" });
    });
  }
}
