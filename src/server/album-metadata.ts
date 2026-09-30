import { createHash } from "node:crypto";
import type { Album, AlbumMetadataCandidate, AlbumMetadataLookup, Track } from "../shared/types.js";
import type { AppConfig } from "./config.js";
import type { DatabaseHandle } from "./db.js";
import { fetchMusicBrainzJson, MetadataLookupError } from "./musicbrainz.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const records = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const positiveInteger = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const normalized = (value: unknown): string => text(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const unknownArtists = new Set(["variousartists", "va", "多位艺人", "未知艺人", "unknownartist", "unknown"]);
const maxCandidates = 12;
type TrackEvidence = Pick<Track, "title" | "duration">;

function genericArtist(value: unknown): boolean { return !normalized(value) || unknownArtists.has(normalized(value)); }

export function albumMetadataQuery(title: string): string {
  // Lucene operators are literal here; never allow a file tag to change the query.
  return `release:"${title.replace(/([+\-!(){}\[\]^"~*?:\\/&|])/g, "\\$1")}"`;
}

function artistsMatch(album: Album, release: RecordValue): boolean {
  const artist = normalized(album.artist);
  if (!artist || unknownArtists.has(artist)) return false;
  const credits = records(release["artist-credit"]);
  const names = credits.map((credit) => text(credit.name) || text(record(credit.artist).name));
  const canonical = credits.map((credit) => text(record(credit.artist).name));
  if ([names.join(""), canonical.join("")].some((value) => normalized(value) === artist)) return true;
  return credits.length === 1 && records(record(credits[0].artist).aliases).some((alias) => normalized(alias.name) === artist);
}

const genreLabels: Record<string, string> = {
  "video game music": "游戏原声", soundtrack: "原声", classical: "古典", jazz: "爵士", rock: "摇滚",
  pop: "流行", electronic: "电子", folk: "民谣", orchestral: "管弦乐", ambient: "氛围音乐"
};
function genreFromRelease(release: RecordValue): string | null {
  const group = record(release["release-group"]);
  const genres = [...records(release.genres), ...records(group.genres)]
    .filter((genre) => text(genre.name) && text(genre.name).length <= 60 && !/[\u0000-\u001f\u007f]/.test(text(genre.name)) && Number(genre.count) > 0)
    .sort((a, b) => Number(b.count) - Number(a.count) || text(a.name).localeCompare(text(b.name)));
  const name = text(genres[0]?.name);
  if (name) return genreLabels[name.toLowerCase()] ?? name;
  return Array.isArray(group["secondary-types"]) && group["secondary-types"].includes("Soundtrack") ? "原声" : null;
}

function candidateFromRelease(album: Album, release: RecordValue): AlbumMetadataCandidate | null {
  const id = text(release.id), title = text(release.title);
  // Similar titles can be different editions. Keep all edition words and numbers when comparing.
  if (!uuid.test(id) || !title || normalized(title) !== normalized(album.title)) return null;
  const media = records(release.media);
  const date = /^[1-9]\d{3}(?:-\d{2}){0,2}$/.test(text(release.date)) ? text(release.date) : null;
  const year = date ? Number(date.slice(0, 4)) : null;
  const counts = media.map((medium) => positiveInteger(medium["track-count"]));
  const trackCount = positiveInteger(release["track-count"]) ?? (counts.length && counts.every((count) => count !== null) ? counts.reduce<number>((sum, count) => sum + count!, 0) : null);
  const discCount = media.length || null;
  const artist = records(release["artist-credit"]).map((credit) => `${text(credit.name) || text(record(credit.artist).name)}${typeof credit.joinphrase === "string" ? credit.joinphrase : ""}`).join("");
  return {
    id, title, year, genre: genreFromRelease(release), date,
    artist, official: release.status === "Official", artistCompatible: artistsMatch(album, release) || genericArtist(album.artist) || genericArtist(artist),
    country: text(release.country) || null,
    format: [...new Set(media.map((medium) => text(medium.format)).filter(Boolean))].join(" / ") || null,
    trackCount, discCount, sourceUrl: `https://musicbrainz.org/release/${id}`,
    matches: {
      artist: artistsMatch(album, release), tracks: trackCount === album.trackCount,
      discs: !album.discCount || discCount === album.discCount,
      year: album.year === null || year === album.year
    }
  };
}

/** Compare multisets rather than disc positions: digital releases often group the same music differently.
 * Duplicate titles retain their multiplicity; durations prevent matching another recording by name alone. */
function trackListMatches(local: TrackEvidence[], release: RecordValue): boolean | undefined {
  if (!local.length) return undefined;
  const media = records(release.media);
  if (!media.length || media.some((medium) => !Array.isArray(medium.tracks))) return undefined;
  const remote = media.flatMap((medium) => records(medium.tracks)).map((track) => {
    const title = text(track.title), recordingTitle = text(record(track.recording).title);
    const aliases = new Set([normalized(title), normalized(recordingTitle)].filter(Boolean));
    // The provider links translated release titles to the same recording. Retain its edition
    // qualifier when constructing the recording-language alias, rather than dropping qualifiers.
    if (recordingTitle) {
      const prefix = title.match(/^(.{2,80}?[:：]\s*)/u)?.[1];
      const suffix = title.match(/(\s*(?:\([^()]+\)|\[[^\[\]]+\]))\s*$/u)?.[1];
      if (prefix) aliases.add(normalized(prefix + recordingTitle));
      if (suffix) aliases.add(normalized(recordingTitle + suffix));
    }
    return { aliases, duration: Number(track.length ?? record(track.recording).length) / 1000 };
  });
  if (remote.length !== local.length) return false;
  const prefixes = local.map((track) => track.title.match(/^(.{3,80}?)[:：]\s*/u));
  const prefixName = normalized(prefixes[0]?.[1]);
  const words = text(release.title).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const albumQualifier = prefixName.length >= 3 && prefixes.every((prefix) => normalized(prefix?.[1]) === prefixName)
    && words.some((word) => normalized(word).startsWith(prefixName));
  const possible = local.map((track, index) => {
    const titles = new Set([normalized(track.title)]);
    // Uniform labels such as "Orc:" are redundant only when the release itself says Orchestral.
    // An unrelated "Live:" / "Remastered:" prefix must keep its identifying meaning.
    if (albumQualifier) titles.add(normalized(track.title.slice(prefixes[index]![0].length)));
    return remote.flatMap((other, otherIndex) => track.duration !== null && track.duration > 0 && Number.isFinite(other.duration)
      && other.duration > 0 && Math.abs(track.duration - other.duration) <= 3
      && [...titles].some((title) => title && other.aliases.has(title)) ? [otherIndex] : []);
  });
  // One-to-one matching handles duplicate titles/aliases without reusing a remote track twice.
  const assigned = new Map<number, number>();
  const match = (index: number, seen: Set<number>): boolean => possible[index].some((other) => {
    if (seen.has(other)) return false;
    seen.add(other);
    if (!assigned.has(other) || match(assigned.get(other)!, seen)) { assigned.set(other, index); return true; }
    return false;
  });
  return possible.every((_, index) => match(index, new Set()));
}

/** A release ID need not be unique for its individual fields to be unambiguous. */
export function albumMetadataConsensus(album: Album, result: AlbumMetadataLookup) {
  if (result.partial || result.truncated) return null;
  const eligible = result.candidates.filter((candidate) => candidate.official && uuid.test(candidate.id)
    && normalized(candidate.title) === normalized(album.title) && candidate.matches.tracks && candidate.trackCount === album.trackCount
    && (album.year === null || candidate.year === null || candidate.year === album.year)
    && candidate.matches.trackList !== false
    && ((candidate.matches.artist && candidate.matches.discs)
      || (album.trackCount >= 3 && candidate.artistCompatible && candidate.matches.trackList === true)));
  function field<T extends number | string>(values: { id: string; value: T | null }[]): { value: T | null; ids: string[] } {
    const known = values.filter((entry): entry is { id: string; value: T } => entry.value !== null);
    if (!known.length || new Set(known.map((entry) => entry.value)).size !== 1) return { value: null, ids: [] };
    return { value: known[0].value, ids: [...new Set(known.map((entry) => entry.id))].sort() };
  }
  const year = field(eligible.map((candidate) => ({ id: candidate.id, value: candidate.year })));
  const genre = field(eligible.map((candidate) => ({ id: candidate.id, value: candidate.genre?.trim() || null })));
  return year.value === null && genre.value === null ? null : { year: year.value, genre: genre.value, sources: { year: year.ids, genre: genre.ids } };
}

export function createAlbumMetadataLookup(config: AppConfig, database: Pick<DatabaseHandle, "getMetadataCache" | "setMetadataCache"> & Partial<Pick<DatabaseHandle, "getAlbum">>, fetcher?: typeof fetch, isActive: () => boolean = () => true) {
  const pending = new Map<string, Promise<AlbumMetadataLookup>>();
  async function query(album: Album, tracks: TrackEvidence[]): Promise<AlbumMetadataLookup> {
    const url = new URL("https://musicbrainz.org/ws/2/release/");
    url.search = new URLSearchParams({ fmt: "json", limit: "100", query: albumMetadataQuery(album.title) }).toString();
    const payload = record(await fetchMusicBrainzJson(url.href, fetcher));
    if (!Array.isArray(payload.releases) || typeof payload.count !== "number") throw new MetadataLookupError(502, "MusicBrainz 返回的信息不完整，请稍后重试。");
    const releases = records(payload.releases);
    const isStrong = (candidate: AlbumMetadataCandidate, release: RecordValue) => Object.values(candidate.matches).every(Boolean) && release.status === "Official";
    const matches = releases.flatMap((release) => {
      const candidate = candidateFromRelease(album, release);
      return candidate ? [{ candidate, release, strong: isStrong(candidate, release) }] : [];
    }).sort((a, b) => Number(b.strong) - Number(a.strong) || Number(b.candidate.matches.artist) - Number(a.candidate.matches.artist) || Number(b.candidate.matches.tracks) - Number(a.candidate.matches.tracks));
    const unique = matches.filter((entry, index) => matches.findIndex((other) => other.candidate.id === entry.candidate.id) === index);
    const truncated = payload.count > releases.length || unique.length > maxCandidates;
    let partial = false;
    const candidates: AlbumMetadataCandidate[] = [];
    // Sequential lookups preserve the shared provider rate limit without filling its pending queue.
    for (const { candidate, release } of unique.slice(0, maxCandidates)) {
      try {
        const detail = record(await fetchMusicBrainzJson(`https://musicbrainz.org/ws/2/release/${candidate.id}?fmt=json&inc=release-groups+genres+recordings+artist-credits`, fetcher));
        if (detail.id !== candidate.id || normalized(detail.title) !== normalized(candidate.title)) throw new Error("Mismatched release detail");
        const full = candidateFromRelease(album, { ...release, ...detail })!;
        const media = records(detail.media);
        const counts = media.map((medium) => positiveInteger(medium["track-count"]));
        if (counts.length && counts.every((count) => count !== null) && counts.reduce<number>((sum, count) => sum + count!, 0) !== album.trackCount) full.matches.tracks = false;
        full.genre = genreFromRelease(detail) ?? candidate.genre;
        full.matches.trackList = trackListMatches(tracks, detail);
        candidates.push(full);
      } catch { partial = true; candidates.push(candidate); }
    }
    const strong = candidates.filter((candidate) => candidate.official && Object.values(candidate.matches).every((value) => value !== false));
    return { candidates, recommendedId: !partial && !truncated && strong.length === 1 ? strong[0].id : null, partial, truncated };
  }
  return async (album: Album): Promise<AlbumMetadataLookup> => {
    if (!config.enableOnlineMetadata) throw new MetadataLookupError(409, "音乐室尚未开启在线信息查询，可先手动填写。");
    if (!album.title.trim() || album.title.length > 512) throw new MetadataLookupError(422, "专辑名称不适合自动查询，请手动补充信息。");
    const tracks = (database.getAlbum?.(album.key)?.tracks ?? []).map(({ title, duration }) => ({ title, duration }));
    // Track content is evidence, so replacing songs without changing the count must invalidate it.
    const key = `album-lookup:v2:${createHash("sha256").update(JSON.stringify([album.title, album.artist, album.trackCount, album.discCount, album.year, tracks])).digest("hex")}`;
    const cached = database.getMetadataCache(key) as { expiresAt?: number; value?: AlbumMetadataLookup } | null;
    if (cached?.value && typeof cached.expiresAt === "number" && cached.expiresAt > Date.now()) return cached.value;
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= 2) throw new MetadataLookupError(429, "正在查询其他专辑，请稍后再试。");
    const promise = query(album, tracks).then((value) => {
      // Empty searches expire sooner; transport failures are never stored as "no match".
      if (!value.partial && isActive()) database.setMetadataCache(key, "MusicBrainz", { value, expiresAt: Date.now() + (value.candidates.length ? 86400000 : 600000) });
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
}
