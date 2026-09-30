import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { DatabaseHandle, UpsertTrack } from "./db.js";
import { fetchMusicBrainzJson } from "./musicbrainz.js";
import { fetchLyricsJson, LyricsLookupError } from "./lyrics-provider.js";
import { safeRealPath } from "./pathSafety.js";
import { parseLyrics } from "../shared/lyrics.js";
import { parseLyricsfile, readLyricsDocument, type LyricsDocument } from "./lyrics-document.js";

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
  lyricsfile?: unknown;
}

function isLrcLibResponse(value: unknown): value is LrcLibResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.trackName === "string" && typeof item.artistName === "string"
    && [item.albumName, item.syncedLyrics, item.plainLyrics].every((text) => text == null || typeof text === "string")
    && (item.duration == null || (typeof item.duration === "number" && Number.isFinite(item.duration)));
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

const parsedLyrics = new WeakMap<LrcLibResponse, LyricsDocument | null>();
function lyricsFromLrcLib(payload: LrcLibResponse): LyricsDocument | null {
  if (parsedLyrics.has(payload)) return parsedLyrics.get(payload)!;
  const rich = parseLyricsfile(payload.lyricsfile);
  const legacy = compact(payload.syncedLyrics) ?? compact(payload.plainLyrics);
  const result = rich && rich.lines.some((line) => line.time !== null) ? rich
    : legacy ? { text: legacy, lines: parseLyrics(legacy) } : rich;
  // Preserve the compatible LRC body from this same candidate when available.
  if (result && rich === result && compact(payload.syncedLyrics)) result.text = payload.syncedLyrics!.trim();
  parsedLyrics.set(payload, result);
  return result;
}

function syncedLyricsFromLrcLib(payload: LrcLibResponse): LyricsDocument | null {
  const lyrics = lyricsFromLrcLib(payload);
  return lyrics?.lines.some((line) => line.time !== null) ? lyrics : null;
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
  // Broad searches include unrelated songs. Text/script and synchronization are preferences,
  // never substitutes for identity. Alternate artist scripts require album + duration evidence.
  if (!matchesAnyLoose(payload.trackName, titles)) return Number.NEGATIVE_INFINITY;
  const durationDelta = track.duration && payload.duration ? Math.abs(payload.duration - track.duration) : null;
  if (durationDelta !== null && durationDelta > 5) return Number.NEGATIVE_INFINITY;
  if (!matchesAnyLoose(payload.artistName, artists)
    && !(sameLoose(payload.albumName, track.album) && durationDelta !== null && durationDelta <= 2)) return Number.NEGATIVE_INFINITY;
  let score = 0;
  if (hasCjkOrKana(lyrics.text)) score += 32;
  if (syncedLyricsFromLrcLib(payload)) score += 24;
  if (lyrics.lines.some((line) => line.words?.length)) score += 4;
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

function selectBestLrcLibResult(track: LyricsLookupTrack, payloads: LrcLibResponse[]): LyricsDocument | null {
  const matches = payloads.filter((payload) => Number.isFinite(scoreLrcLibResult(track, payload)));
  const syncedPayloads = matches.filter((payload) => syncedLyricsFromLrcLib(payload));
  const eligiblePayloads = syncedPayloads.length > 0 ? syncedPayloads : matches;
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
  if (new URL(url).hostname === "musicbrainz.org") return fetchMusicBrainzJson<T>(url, fetcher).catch(() => null);
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

const lyricsInFlight = new WeakMap<DatabaseHandle, Map<string, Promise<string | null>>>();

export async function lookupLyrics(config: AppConfig, track: LyricsLookupTrack, database: DatabaseHandle, fetcher: FetchLike = globalThis.fetch, options: { refresh?: boolean } = {}): Promise<string | null> {
  if (!config.enableOnlineMetadata) return null;
  const artists = lyricArtistCandidates(track);
  const titles = lyricTitleCandidates(track);
  if (titles.length === 0 || artists.length === 0) return null;
  const key = cacheKey("lrclib:v7", [titles.join("|"), artists.join("|"), track.album, Math.round(track.duration ?? 0)]);
  let pending = lyricsInFlight.get(database);
  if (!pending) { pending = new Map(); lyricsInFlight.set(database, pending); }
  const existing = pending.get(key);
  if (existing) return existing;
  const request = lookupLyricsUncached(config, track, database, fetcher, options, key, titles, artists);
  pending.set(key, request);
  try { return await request; } finally { pending.delete(key); }
}

async function lookupLyricsUncached(config: AppConfig, track: LyricsLookupTrack, database: DatabaseHandle, fetcher: FetchLike,
  options: { refresh?: boolean }, key: string, titles: string[], artists: string[]): Promise<string | null> {
  const cached = database.getMetadataCache(key) as { lyricsPath?: string | null; expiresAt?: number } | null;
  if (!options.refresh && cached) {
    if (cached.lyricsPath) {
      try {
        const safePath = safeRealPath(config.metadataDir, cached.lyricsPath);
        if (readLyricsDocument(await fs.readFile(safePath, "utf8"), safePath.endsWith(".lyrics.json"))) return cached.lyricsPath;
      } catch { /* A stale cache pointer must not prevent a new search. */ }
    } else if (cached.expiresAt && cached.expiresAt > Date.now()) return null;
  }

  const candidates: LrcLibResponse[] = [];
  const deadline = AbortSignal.timeout(20_000);
  let providerUnavailable = false;
  const query = async (url: URL, search = false) => {
    if (providerUnavailable) return;
    try {
      const payload = await fetchLyricsJson(url, fetcher, deadline);
      if (payload === null) return;
      const values = search ? payload : [payload];
      if (!Array.isArray(values) || !values.every(isLrcLibResponse)) throw new LyricsLookupError();
      candidates.push(...values);
    } catch (error) {
      if (!(error instanceof LyricsLookupError) || !selectBestLrcLibResult(track, candidates)) throw error;
      // Optional alternatives must not discard a usable match when the provider goes offline.
      providerUnavailable = true;
    }
  };

  for (const title of titles) {
    for (const artist of artists) {
      const url = new URL("https://lrclib.net/api/get");
      url.searchParams.set("track_name", title);
      url.searchParams.set("artist_name", artist);
      if (track.album) url.searchParams.set("album_name", track.album);
      if (track.duration) url.searchParams.set("duration", String(Math.round(track.duration)));

      await query(url);
    }
  }

  const bestExactLyrics = selectBestLrcLibResult(track, candidates);
  if (!bestExactLyrics || !hasCjkOrKana(bestExactLyrics.text)) {
    for (const title of titles) {
      for (const artist of artists) {
        const url = new URL("https://lrclib.net/api/search");
        url.searchParams.set("track_name", title);
        url.searchParams.set("artist_name", artist);
        await query(url, true);
      }
    }
  }

  if (!selectBestLrcLibResult(track, candidates)) {
    for (const text of lyricQueryCandidates(track, titles, artists)) {
      const url = new URL("https://lrclib.net/api/search");
      url.searchParams.set("q", text);
      await query(url, true);
      if (selectBestLrcLibResult(track, candidates)) break;
    }
  }

  const lyrics = selectBestLrcLibResult(track, candidates);
  if (!lyrics) {
    database.setMetadataCache(key, "LRCLIB", { lyricsPath: null, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    return null;
  }

  const lyricsDir = path.join(config.metadataDir, "lyrics");
  await fs.mkdir(lyricsDir, { recursive: true });
  const safeDir = safeRealPath(config.metadataDir, lyricsDir);
  const lyricsPath = path.join(lyricsDir, safeFileName(`online-${track.id}`, "lyrics.json"));
  const temporary = path.join(safeDir, `${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, ...lyrics }), { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, lyricsPath);
  } finally { await fs.rm(temporary, { force: true }); }
  database.setMetadataCache(key, "LRCLIB", { lyricsPath });
  return lyricsPath;
}

export async function enrichTrackMetadata(
  config: AppConfig,
  database: DatabaseHandle,
  track: UpsertTrack,
  fetcher: FetchLike = globalThis.fetch
): Promise<UpsertTrack> {
  if (!config.enableOnlineMetadata || config.scanOnlineMetadata === false) return track;

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
