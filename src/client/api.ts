import type { LyricsResponse } from "../shared/lyrics.js";
import type { LightingProgram } from "../shared/lighting-program.js";
import type { AccountUser, AccountSession, SessionResponse, UserPreferences, DirectoryState } from "../shared/accounts.js";
import type { Album, AlbumMetadata, AlbumMetadataLookup, AlbumMetadataValues, Artist, CatalogStatus, LibrarySummary, MetadataStatus, Page, PagedSearchResponse, PageOptions, Playlist, PlaylistDetail, ScanError, ScanJob, SearchResponse, Track, TrackPageOptions } from "../shared/types.js";
import { collectTrackPages } from "./library-data.js";

export interface ScanOptions {
  force?: boolean;
  prune?: boolean;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, init?: RequestInit, notifyUnauthorized = true): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "include",
      headers,
      ...init
    });
  } catch (error) {
    if (init?.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new Error("无法连接服务，请检查网络后重试。");
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (notifyUnauthorized && response.status === 401 && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event("music:session-expired"));
    throw new ApiError(body.error ?? `HTTP ${response.status}`, response.status);
  }

  return response.json() as Promise<T>;
}

function pageQuery(options: TrackPageOptions): string {
  const params = new URLSearchParams({ page: "true" });
  if (options.q !== undefined) params.set("q", options.q);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  if (options.favorite !== undefined) params.set("favorite", String(options.favorite));
  return `?${params}`;
}

function trackPage(options: TrackPageOptions = {}, signal?: AbortSignal): Promise<Page<Track>> {
  return request<Page<Track>>(`/api/tracks${pageQuery(options)}`, { signal });
}

function albumPage(options: PageOptions = {}, signal?: AbortSignal): Promise<Page<Album>> {
  return request<Page<Album>>(`/api/albums${pageQuery(options)}`, { signal });
}

function artistPage(options: PageOptions = {}, signal?: AbortSignal): Promise<Page<Artist>> {
  return request<Page<Artist>>(`/api/artists${pageQuery(options)}`, { signal });
}

export const api = {
  lighting: (id: string, signal?: AbortSignal) => request<{ program: LightingProgram }>(`/api/tracks/${encodeURIComponent(id)}/lighting`, { signal }),
  me: (signal?: AbortSignal, notifyUnauthorized = true) => request<SessionResponse>("/api/me", { signal }, notifyUnauthorized),
  login: (username: string, password: string) => request<{ ok: true; user: AccountUser }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  password: (currentPassword: string, password: string) => request<{ user: AccountUser; loggedOut: boolean }>("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, password }) }),
  profile: (profile: Pick<AccountUser, "displayName" | "bio" | "color">) => request<AccountUser>("/api/account/profile", { method: "PATCH", body: JSON.stringify(profile) }),
  preferences: (preferences: Partial<UserPreferences>) => request<UserPreferences>("/api/account/preferences", { method: "PATCH", body: JSON.stringify(preferences) }),
  users: () => request<AccountUser[]>("/api/admin/users"),
  createUser: (body: { username: string; displayName: string; role: string; grantConfirmed: boolean }) => request<{ user: AccountUser; temporaryPassword: string }>("/api/admin/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (id: string, body: { displayName?: string; role?: string; status?: string; grantConfirmed?: boolean }) => request<AccountUser>(`/api/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  resetPassword: (id: string, password: string) => request<AccountUser>(`/api/admin/users/${encodeURIComponent(id)}/password`, { method: "POST", body: JSON.stringify({ password }) }),
  sessions: () => request<AccountSession[]>("/api/account/sessions"),
  revokeSessions: (ids: string[]) => request<{ ok: true }>("/api/account/sessions", { method: "DELETE", body: JSON.stringify({ ids }) }),
  directories: (path?: string) => request<DirectoryState>(`/api/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  selectDirectory: (path: string) => request<{ directory: DirectoryState; scan: ScanJob | null }>("/api/directories", { method: "PUT", body: JSON.stringify({ path }) }),
  stopScan: () => request<ScanJob | null>("/api/scan/stop", { method: "POST" }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  summary: (signal?: AbortSignal) => request<LibrarySummary>("/api/summary", { signal }),
  scan: (options?: ScanOptions, signal?: AbortSignal) => request<ScanJob | null>("/api/scan", {
    method: "POST", ...(options ? { body: JSON.stringify(options) } : {}), signal
  }),
  scanStatus: (signal?: AbortSignal) => request<ScanJob | null>("/api/scan", { signal }),
  scanErrors: (signal?: AbortSignal) => request<ScanError[]>("/api/scan/errors", { signal }),
  metadataStatus: (signal?: AbortSignal) => request<MetadataStatus>("/api/metadata/status", { signal }),
  catalogStatus: (signal?: AbortSignal) => request<CatalogStatus>("/api/catalog/status", { signal }),
  tracks: (params = "", signal?: AbortSignal) => request<Track[]>(`/api/tracks${params}`, { signal }),
  track: (id: string, signal?: AbortSignal) => request<Track>(`/api/tracks/${encodeURIComponent(id)}`, { signal }),
  availability: (id: string) => request<{ available: true }>(`/api/tracks/${encodeURIComponent(id)}/availability`),
  trackPage,
  albumPage,
  artistPage,
  searchPages: async (q: string, signal?: AbortSignal): Promise<PagedSearchResponse> => {
    const [tracks, albums, artists] = await Promise.all([
      trackPage({ q, limit: 25 }, signal),
      albumPage({ q, limit: 12 }, signal),
      artistPage({ q, limit: 12 }, signal)
    ]);
    return { tracks, albums, artists };
  },
  allTracks: (options: Pick<TrackPageOptions, "q" | "favorite"> = {}, signal?: AbortSignal, onProgress?: (loaded: number, total: number) => void) =>
    collectTrackPages((offset, limit) => trackPage({ ...options, offset, limit }, signal), signal, onProgress),
  albums: (signal?: AbortSignal) => request<Album[]>("/api/albums", { signal }),
  album: (key: string, signal?: AbortSignal) => request<{ album: Album; tracks: Track[] }>(`/api/albums/${encodeURIComponent(key)}`, { signal }),
  albumMetadata: (key: string, signal?: AbortSignal) => request<AlbumMetadata>(`/api/admin/albums/${encodeURIComponent(key)}/metadata`, { signal }),
  lookupAlbumMetadata: (key: string, revision: string, signal?: AbortSignal) => request<AlbumMetadataLookup>(`/api/admin/albums/${encodeURIComponent(key)}/metadata/lookup`, { method: "POST", body: JSON.stringify({ revision }), signal }),
  saveAlbumMetadata: (key: string, values: AlbumMetadataValues, revision: string) => request<AlbumMetadata>(`/api/admin/albums/${encodeURIComponent(key)}/metadata`, { method: "PUT", body: JSON.stringify({ ...values, revision }) }),
  artists: (signal?: AbortSignal) => request<Artist[]>("/api/artists", { signal }),
  artist: (name: string, signal?: AbortSignal) => request<{ artist: Artist; albums: Album[]; tracks: Track[] }>(`/api/artists/${encodeURIComponent(name)}`, { signal }),
  search: (q: string, signal?: AbortSignal) => request<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`, { signal }),
  favorite: (trackId: string, favorite: boolean) =>
    request<Track>(`/api/tracks/${trackId}/favorite`, { method: "PATCH", body: JSON.stringify({ favorite }) }),
  lyrics: (trackId: string, search = false, signal?: AbortSignal) => fetch(`/api/tracks/${trackId}/lyrics?format=json${search ? "&search=1" : ""}`, { credentials: "include", signal }).then((response) => {
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event("music:session-expired"));
      const error = new Error(response.status === 404 ? "暂无歌词" : "歌词暂时无法载入") as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return response.json() as Promise<LyricsResponse>;
  }),
  playlists: (signal?: AbortSignal) => request<Playlist[]>("/api/playlists", { signal }),
  createPlaylist: (name: string, requestId?: string) => request<Playlist>("/api/playlists", { method: "POST", body: JSON.stringify({ name, requestId }) }),
  playlist: (id: string, signal?: AbortSignal) => request<PlaylistDetail>(`/api/playlists/${encodeURIComponent(id)}`, { signal }),
  renamePlaylist: (id: string, name: string) =>
    request<Playlist>(`/api/playlists/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deletePlaylist: (id: string) =>
    request<{ ok: true }>(`/api/playlists/${encodeURIComponent(id)}`, { method: "DELETE" }),
  removeFromPlaylist: (playlistId: string, trackId: string) =>
    request<PlaylistDetail>(`/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(trackId)}`, { method: "DELETE" }),
  reorderPlaylist: (playlistId: string, trackIds: string[], revision: string) =>
    request<PlaylistDetail>(`/api/playlists/${encodeURIComponent(playlistId)}/tracks/order`, { method: "PUT", body: JSON.stringify({ trackIds, revision }) }),
  addToPlaylist: (playlistId: string, trackId: string) =>
    request<PlaylistDetail>(`/api/playlists/${encodeURIComponent(playlistId)}/tracks`, { method: "POST", body: JSON.stringify({ trackId }) })
};

export function artworkUrl(trackId: string | null | undefined): string | undefined {
  return trackId ? `/api/tracks/${trackId}/artwork` : undefined;
}

export function streamUrl(trackId: string, start?: number): string {
  const suffix = start && start > 0 ? `?start=${encodeURIComponent(String(Math.max(0, start)))}` : "";
  return `/api/tracks/${trackId}/stream${suffix}`;
}
