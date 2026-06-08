import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { DatabaseHandle, UpsertTrack } from "./db.js";

type FetchLike = typeof fetch;

interface MusicBrainzRecording {
  title?: string;
  "artist-credit"?: Array<{ name?: string; artist?: { name?: string } }>;
  releases?: Array<{
    id?: string;
    title?: string;
    date?: string;
    "artist-credit"?: Array<{ name?: string; artist?: { name?: string } }>;
  }>;
}

interface MusicBrainzSearchResponse {
  recordings?: MusicBrainzRecording[];
}

interface LrcLibResponse {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
}

interface OnlineMetadata {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  year?: number | null;
  releaseId?: string | null;
}

interface CoverArtResponse {
  images?: Array<{
    front?: boolean;
    image?: string;
    thumbnails?: Record<string, string>;
  }>;
}

export interface MetadataStatusDetails {
  enabled: boolean;
  providers: string[];
  mode: "local-first";
  cachedItems: number;
  cacheDir: string;
}

function compact(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function cacheKey(prefix: string, parts: Array<string | number | null | undefined>): string {
  const raw = parts.map((part) => String(part ?? "").toLowerCase().trim()).join("\u0000");
  return `${prefix}:${createHash("sha1").update(raw).digest("hex")}`;
}

function yearFromDate(date: string | undefined): number | null {
  const match = /^(\d{4})/.exec(date ?? "");
  return match ? Number(match[1]) : null;
}

function firstArtist(credits: MusicBrainzRecording["artist-credit"]): string | null {
  return compact(credits?.map((credit) => credit.artist?.name ?? credit.name).filter(Boolean).join(""));
}

function safeFileName(id: string, ext: string): string {
  return `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.${ext}`;
}

async function fetchJson<T>(url: string, fetcher: FetchLike): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "NASMusicLibrary/0.1 (local-first personal music library)"
      },
      signal: controller.signal
    });
    if (!response.ok) return null;
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBytes(url: string, fetcher: FetchLike): Promise<{ bytes: Uint8Array; contentType: string | null } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetcher(url, {
      headers: {
        "Accept": "image/*,text/plain",
        "User-Agent": "NASMusicLibrary/0.1 (local-first personal music library)"
      },
      signal: controller.signal
    });
    if (!response.ok) return null;
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type")
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function musicBrainzQuery(track: Pick<UpsertTrack, "title" | "artist" | "album">): string {
  const clauses = [`recording:"${track.title.replaceAll("\"", "")}"`];
  if (track.artist) clauses.push(`artist:"${track.artist.replaceAll("\"", "")}"`);
  if (track.album) clauses.push(`release:"${track.album.replaceAll("\"", "")}"`);
  return clauses.join(" AND ");
}

export function parseMusicBrainz(data: MusicBrainzSearchResponse): OnlineMetadata | null {
  const recording = data.recordings?.[0];
  if (!recording) return null;
  const release = recording.releases?.[0];
  return {
    title: compact(recording.title),
    artist: firstArtist(recording["artist-credit"]),
    album: compact(release?.title),
    albumArtist: firstArtist(release?.["artist-credit"]),
    year: yearFromDate(release?.date),
    releaseId: compact(release?.id)
  };
}

async function lookupMusicBrainz(track: UpsertTrack, database: DatabaseHandle, fetcher: FetchLike): Promise<OnlineMetadata | null> {
  const key = cacheKey("musicbrainz", [track.title, track.artist, track.album]);
  const cached = database.getMetadataCache(key) as { value?: OnlineMetadata | null } | null;
  if (cached) return cached.value ?? null;

  const url = new URL("https://musicbrainz.org/ws/2/recording/");
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", "3");
  url.searchParams.set("query", musicBrainzQuery(track));

  const payload = await fetchJson<MusicBrainzSearchResponse>(url.toString(), fetcher);
  const value = payload ? parseMusicBrainz(payload) : null;
  database.setMetadataCache(key, "MusicBrainz", { value });
  return value;
}

async function lookupCoverArt(config: AppConfig, releaseId: string | null | undefined, trackId: string, database: DatabaseHandle, fetcher: FetchLike): Promise<string | null> {
  if (!releaseId) return null;
  const key = cacheKey("coverartarchive", [releaseId]);
  const cached = database.getMetadataCache(key) as { artworkPath?: string | null } | null;
  if (cached) return cached.artworkPath ?? null;

  const payload = await fetchJson<CoverArtResponse>(`https://coverartarchive.org/release/${encodeURIComponent(releaseId)}`, fetcher);
  const image = payload?.images?.find((item) => item.front)?.image ?? payload?.images?.[0]?.image;
  if (!image) {
    database.setMetadataCache(key, "Cover Art Archive", { artworkPath: null });
    return null;
  }

  const imageResponse = await fetchBytes(image, fetcher);
  if (!imageResponse) {
    database.setMetadataCache(key, "Cover Art Archive", { artworkPath: null });
    return null;
  }

  const ext = imageResponse.contentType?.includes("png") ? "png" : "jpg";
  const artworkPath = path.join(config.artworkDir, safeFileName(`online-${trackId}`, ext));
  await fs.writeFile(artworkPath, imageResponse.bytes);
  database.setMetadataCache(key, "Cover Art Archive", { artworkPath });
  return artworkPath;
}

async function lookupLyrics(config: AppConfig, track: UpsertTrack, database: DatabaseHandle, fetcher: FetchLike): Promise<string | null> {
  const artist = track.artist ?? track.albumArtist;
  if (!track.title || !artist) return null;
  const key = cacheKey("lrclib", [track.title, artist, track.album, Math.round(track.duration ?? 0)]);
  const cached = database.getMetadataCache(key) as { lyricsPath?: string | null } | null;
  if (cached) return cached.lyricsPath ?? null;

  const url = new URL("https://lrclib.net/api/get");
  url.searchParams.set("track_name", track.title);
  url.searchParams.set("artist_name", artist);
  if (track.album) url.searchParams.set("album_name", track.album);
  if (track.duration) url.searchParams.set("duration", String(Math.round(track.duration)));

  const payload = await fetchJson<LrcLibResponse>(url.toString(), fetcher);
  const lyrics = compact(payload?.syncedLyrics) ?? compact(payload?.plainLyrics);
  if (!lyrics) {
    database.setMetadataCache(key, "LRCLIB", { lyricsPath: null });
    return null;
  }

  const lyricsDir = path.join(config.metadataDir, "lyrics");
  await fs.mkdir(lyricsDir, { recursive: true });
  const lyricsPath = path.join(lyricsDir, safeFileName(`online-${track.id}`, "lrc"));
  await fs.writeFile(lyricsPath, lyrics, "utf8");
  database.setMetadataCache(key, "LRCLIB", { lyricsPath });
  return lyricsPath;
}

export async function enrichTrackMetadata(
  config: AppConfig,
  database: DatabaseHandle,
  track: UpsertTrack,
  fetcher: FetchLike = globalThis.fetch
): Promise<UpsertTrack> {
  if (!config.enableOnlineMetadata) return track;

  const needsTags = !track.album || !track.artist || !track.year;
  const online = needsTags ? await lookupMusicBrainz(track, database, fetcher).catch(() => null) : null;
  const enriched: UpsertTrack = {
    ...track,
    title: track.title || online?.title || track.fileName,
    album: track.album ?? online?.album ?? null,
    artist: track.artist ?? online?.artist ?? null,
    albumArtist: track.albumArtist ?? online?.albumArtist ?? online?.artist ?? null,
    year: track.year ?? online?.year ?? null
  };

  if (!enriched.artworkPath) {
    enriched.artworkPath = await lookupCoverArt(config, online?.releaseId, enriched.id, database, fetcher).catch(() => null);
  }

  if (!enriched.lyricsPath) {
    enriched.lyricsPath = await lookupLyrics(config, enriched, database, fetcher).catch(() => null);
  }

  return enriched;
}

export function metadataStatus(config: AppConfig, database: DatabaseHandle): MetadataStatusDetails {
  return {
    enabled: config.enableOnlineMetadata,
    providers: ["MusicBrainz", "Cover Art Archive", "LRCLIB"],
    mode: "local-first",
    cachedItems: database.metadataCacheCount(),
    cacheDir: config.metadataDir
  };
}
