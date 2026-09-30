import type { Album as ApiAlbum, Track as ApiTrack, PlaylistDetail } from "../../shared/types.js";
import { api, artworkUrl } from "../api.js";

export type Track = ApiTrack & { albumId: string; artist: string; duration: number; disc: number; format: string };
export type Album = { id: string; name: string; title: string; artist: string; year: number; genre: string; cover: string; duration: number; trackCount: number; lossless: boolean };
export type Playlist = { id: string; name: string; description: string; trackIds: string[]; revision: string; detailError?: string; detailLoading?: boolean };
export type ArtistEntry = { name: string; albumIds: Set<string>; trackIds: Set<string> };
export const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : "连接暂时中断，请稍后重试。";

export function mapTrack(track: ApiTrack): Track {
  return { ...track, title: track.title?.trim() || track.fileName || "未命名歌曲", artist: track.artist?.trim() || track.albumArtist?.trim() || "未知艺人", albumId: track.albumKey ?? `${track.album}::${track.albumArtist ?? track.artist}`, duration: track.duration ?? 0, disc: track.discNo ?? 1, format: track.formatGroup.toUpperCase() };
}
export function mapAlbum(album: ApiAlbum, tracks: Track[]): Album {
  const members = tracks.filter((track) => track.albumId === album.key);
  const genre = album.genre === undefined ? members.find((track) => track.genre?.trim())?.genre : album.genre;
  return { id: album.key, name: album.title || "未命名专辑", title: album.title || "未命名专辑", artist: album.artist?.trim() || "未知艺人", year: album.year ?? 0, genre: genre?.trim() || "未分类", cover: artworkUrl(album.artworkTrackId) ?? "", duration: album.duration, trackCount: album.trackCount, lossless: members.length > 0 && members.every((track) => track.lossless) };
}
export function mapPlaylist(detail: PlaylistDetail): Playlist {
  return { id: detail.playlist.id, name: detail.playlist.name, description: detail.playlist.description ?? "喜欢的音乐，慢慢收集。", trackIds: detail.tracks.map((track) => track.id), revision: detail.revision };
}

export async function loadAlbums(signal: AbortSignal): Promise<ApiAlbum[]> {
  const result: ApiAlbum[] = [];
  do {
    signal.throwIfAborted();
    const page = await api.albumPage({ limit: 500, offset: result.length }, signal);
    result.push(...page.items);
    if (result.length >= page.total || !page.items.length) break;
  } while (!signal.aborted);
  signal.throwIfAborted();
  return result;
}

export async function loadPlaylists(signal: AbortSignal): Promise<Playlist[]> {
  const listed = await api.playlists(signal);
  const result: Playlist[] = [];
  // One failed detail must not hide the remaining playlists or the shared library.
  for (let index = 0; index < listed.length; index += 8) {
    signal.throwIfAborted();
    const batch = listed.slice(index, index + 8);
    const details = await Promise.allSettled(batch.map((item) => api.playlist(item.id, signal)));
    signal.throwIfAborted();
    details.forEach((detail, offset) => {
      const item = batch[offset];
      result.push(detail.status === "fulfilled" ? mapPlaylist(detail.value) : {
        id: item.id, name: item.name, description: item.description ?? "喜欢的音乐，慢慢收集。",
        trackIds: [], revision: "", detailError: errorMessage(detail.reason)
      });
    });
  }
  return result;
}

export function mergePlaylistResults(previous: Playlist[], next: Playlist[]): Playlist[] {
  const cached = new Map(previous.map((item) => [item.id, item]));
  return next.map((item) => {
    const prior = cached.get(item.id);
    return item.detailError && prior ? { ...item, trackIds: prior.trackIds, revision: prior.revision } : item;
  });
}

/** Song rows and the player can retain their artwork when the album endpoint fails. */
export function buildAlbumMap(albums: Album[], tracks: Track[]): Map<string, Album> {
  const map = new Map(albums.map((album) => [album.id, album]));
  for (const track of tracks) {
    if (!map.has(track.albumId)) map.set(track.albumId, {
      id: track.albumId, name: track.album || "未命名专辑", title: track.album || "未命名专辑",
      artist: track.albumArtist?.trim() || track.artist, year: track.year ?? 0, genre: track.genre || "未分类",
      cover: track.hasArtwork ? artworkUrl(track.id) ?? "" : "", duration: 0, trackCount: 0, lossless: false
    });
  }
  return map;
}

/** Keep exact metadata names: splitting on '/' would corrupt names such as AC/DC. */
export function buildArtistIndex(albums: Album[], tracks: Track[]): ArtistEntry[] {
  const index = new Map<string, ArtistEntry>();
  const albumArtists = new Map(albums.map((album) => [album.id, album.artist]));
  const entry = (name: string) => {
    const normalized = name.trim() || "未知艺人";
    let item = index.get(normalized);
    if (!item) { item = { name: normalized, albumIds: new Set(), trackIds: new Set() }; index.set(normalized, item); }
    return item;
  };
  for (const album of albums) entry(album.artist).albumIds.add(album.id);
  for (const track of tracks) {
    for (const name of new Set([track.artist, albumArtists.get(track.albumId) || track.albumArtist?.trim() || track.artist])) {
      const item = entry(name);
      item.albumIds.add(track.albumId);
      item.trackIds.add(track.id);
    }
  }
  return [...index.values()];
}
