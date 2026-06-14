import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { DatabaseHandle, UpsertTrack } from "./db.js";

type FetchLike = typeof fetch;
type LyricsLookupTrack = Pick<UpsertTrack, "id" | "title" | "artist" | "albumArtist" | "album" | "duration">;

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
  trackName?: string | null;
  artistName?: string | null;
  albumName?: string | null;
  duration?: number | null;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
}

type LrcLibSearchResponse = LrcLibResponse[];

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

function uniqueCompact(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = compact(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function lyricArtistCandidates(track: LyricsLookupTrack): string[] {
  const artist = track.artist ?? track.albumArtist;
  return uniqueCompact([
    artist,
    track.albumArtist && track.albumArtist !== artist ? track.albumArtist : null
  ]);
}

function stripTitleSuffix(title: string): string | null {
  const stripped = title
    .replace(/\s*[\[(（【].*?[\])）】]\s*/g, " ")
    .replace(/\s+-\s*(?:.*\b(?:ver\.?|version|edit|mix|remaster(?:ed)?|live|instrumental|karaoke|demo)\b.*)$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped && stripped.toLowerCase() !== title.trim().toLowerCase() ? stripped : null;
}

function lyricTitleCandidates(track: LyricsLookupTrack): string[] {
  return uniqueCompact([
    track.title,
    stripTitleSuffix(track.title)
  ]);
}

function lyricsFromLrcLib(payload: LrcLibResponse | null): string | null {
  return compact(payload?.syncedLyrics) ?? compact(payload?.plainLyrics);
}

function syncedLyricsFromLrcLib(payload: LrcLibResponse | null): string | null {
  return compact(payload?.syncedLyrics);
}

function hasCjkOrKana(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

function normalizeLoose(value: string | null | undefined): string {
  return compact(value)
    ?.normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[’'`´]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "") ?? "";
}

function sameLoose(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeLoose(left);
  return Boolean(normalizedLeft) && normalizedLeft === normalizeLoose(right);
}

function matchesAnyLoose(value: string | null | undefined, candidates: string[]): boolean {
  return candidates.some((candidate) => sameLoose(value, candidate));
}

function containsAnyLoose(value: string | null | undefined, candidates: string[]): boolean {
  const normalizedValue = normalizeLoose(value);
  if (!normalizedValue) return false;
  return candidates.some((candidate) => {
    const normalizedCandidate = normalizeLoose(candidate);
    return Boolean(normalizedCandidate) && (
      normalizedValue.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedValue)
    );
  });
}

function lyricQueryCandidates(track: LyricsLookupTrack, titles: string[], artists: string[]): string[] {
  const queries: string[] = [];
  for (const title of titles) {
    for (const artist of artists) {
      queries.push(`${title} ${artist}`);
      queries.push(`${artist} ${title}`);
    }
    if (track.album) queries.push(`${title} ${track.album}`);
    queries.push(title);
  }
  return uniqueCompact(queries).slice(0, 8);
}

function scoreLrcLibResult(track: LyricsLookupTrack, payload: LrcLibResponse): number {
  const lyrics = syncedLyricsFromLrcLib(payload) ?? lyricsFromLrcLib(payload);
  if (!lyrics) return Number.NEGATIVE_INFINITY;
  const titles = lyricTitleCandidates(track);
  const artists = lyricArtistCandidates(track);
  let score = 0;
  if (hasCjkOrKana(lyrics)) score += 32;
  if (compact(payload.syncedLyrics)) score += 24;
  if (matchesAnyLoose(payload.trackName, titles)) {
    score += 16;
  } else if (containsAnyLoose(payload.trackName, titles)) {
    score += 6;
  } else if (compact(payload.trackName)) {
    score -= 24;
  }
  if (matchesAnyLoose(payload.artistName, artists)) {
    score += 10;
  } else if (compact(payload.artistName)) {
    score -= 8;
  }
  if (sameLoose(payload.albumName, track.album)) score += 4;
  if (track.duration && payload.duration) {
    const durationDelta = Math.abs(payload.duration - track.duration);
    if (durationDelta <= 2) score += 8;
    else if (durationDelta <= 5) score += 4;
  }
  return score;
}

function selectBestLrcLibResult(track: LyricsLookupTrack, payloads: LrcLibResponse[]): string | null {
  const syncedPayloads = payloads.filter((payload) => syncedLyricsFromLrcLib(payload));
  const eligiblePayloads = syncedPayloads.length > 0 ? syncedPayloads : payloads;
  let bestPayload: LrcLibResponse | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const payload of eligiblePayloads) {
    const score = scoreLrcLibResult(track, payload);
    if (score > bestScore) {
      bestScore = score;
      bestPayload = payload;
    }
  }
  if (!bestPayload) return null;
  return syncedPayloads.length > 0 ? syncedLyricsFromLrcLib(bestPayload) : lyricsFromLrcLib(bestPayload);
}

async function fetchJson<T>(url: string, fetcher: FetchLike): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
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
  } catch {
    return null;
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

export async function lookupLyrics(config: AppConfig, track: LyricsLookupTrack, database: DatabaseHandle, fetcher: FetchLike = globalThis.fetch): Promise<string | null> {
  const artists = lyricArtistCandidates(track);
  const titles = lyricTitleCandidates(track);
  if (titles.length === 0 || artists.length === 0) return null;
  const key = cacheKey("lrclib:v5", [titles.join("|"), artists.join("|"), track.album, Math.round(track.duration ?? 0)]);
  const cached = database.getMetadataCache(key) as { lyricsPath?: string | null } | null;
  if (cached) return cached.lyricsPath ?? null;

  const candidates: LrcLibResponse[] = [];

  for (const title of titles) {
    for (const artist of artists) {
      const url = new URL("https://lrclib.net/api/get");
      url.searchParams.set("track_name", title);
      url.searchParams.set("artist_name", artist);
      if (track.album) url.searchParams.set("album_name", track.album);
      if (track.duration) url.searchParams.set("duration", String(Math.round(track.duration)));

      const payload = await fetchJson<LrcLibResponse>(url.toString(), fetcher);
      if (payload) candidates.push(payload);
    }
  }

  const bestExactLyrics = selectBestLrcLibResult(track, candidates);
  if (!bestExactLyrics || !hasCjkOrKana(bestExactLyrics)) {
    for (const title of titles) {
      for (const artist of artists) {
        const url = new URL("https://lrclib.net/api/search");
        url.searchParams.set("track_name", title);
        url.searchParams.set("artist_name", artist);
        const payload = await fetchJson<LrcLibSearchResponse>(url.toString(), fetcher);
        if (Array.isArray(payload)) candidates.push(...payload);
      }
    }
  }

  if (!selectBestLrcLibResult(track, candidates)) {
    for (const query of lyricQueryCandidates(track, titles, artists)) {
      const url = new URL("https://lrclib.net/api/search");
      url.searchParams.set("q", query);
      const payload = await fetchJson<LrcLibSearchResponse>(url.toString(), fetcher);
      if (Array.isArray(payload)) candidates.push(...payload);
      if (selectBestLrcLibResult(track, candidates)) break;
    }
  }

  const lyrics = selectBestLrcLibResult(track, candidates);
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
