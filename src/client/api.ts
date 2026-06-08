import type { Album, Artist, LibrarySummary, MetadataStatus, Playlist, ScanError, ScanJob, SearchResponse, Track } from "../shared/types.js";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    credentials: "include",
    headers,
    ...init
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  me: () => request<{ user: { name: string } }>("/api/me"),
  login: (password: string) => request<{ ok: true }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  summary: () => request<LibrarySummary>("/api/summary"),
  scan: () => request<ScanJob | null>("/api/scan", { method: "POST" }),
  scanStatus: () => request<ScanJob | null>("/api/scan"),
  scanErrors: () => request<ScanError[]>("/api/scan/errors"),
  metadataStatus: () => request<MetadataStatus>("/api/metadata/status"),
  tracks: (params = "") => request<Track[]>(`/api/tracks${params}`),
  albums: () => request<Album[]>("/api/albums"),
  album: (key: string) => request<{ album: Album; tracks: Track[] }>(`/api/albums/${encodeURIComponent(key)}`),
  artists: () => request<Artist[]>("/api/artists"),
  artist: (name: string) => request<{ artist: Artist; albums: Album[]; tracks: Track[] }>(`/api/artists/${encodeURIComponent(name)}`),
  search: (q: string) => request<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`),
  favorite: (trackId: string, favorite: boolean) =>
    request<Track>(`/api/tracks/${trackId}/favorite`, { method: "PATCH", body: JSON.stringify({ favorite }) }),
  lyrics: (trackId: string) => fetch(`/api/tracks/${trackId}/lyrics`, { credentials: "include" }).then((response) => {
    if (!response.ok) throw new Error("暂无歌词");
    return response.text();
  }),
  playlists: () => request<Playlist[]>("/api/playlists"),
  createPlaylist: (name: string) => request<Playlist>("/api/playlists", { method: "POST", body: JSON.stringify({ name }) }),
  playlist: (id: string) => request<{ playlist: Playlist; tracks: Track[] }>(`/api/playlists/${id}`),
  addToPlaylist: (playlistId: string, trackId: string) =>
    request<{ playlist: Playlist; tracks: Track[] }>(`/api/playlists/${playlistId}/tracks`, { method: "POST", body: JSON.stringify({ trackId }) })
};

export function artworkUrl(trackId: string | null | undefined): string | undefined {
  return trackId ? `/api/tracks/${trackId}/artwork` : undefined;
}

export function streamUrl(trackId: string, start?: number): string {
  const suffix = start && start > 0 ? `?start=${encodeURIComponent(String(Math.max(0, Math.floor(start))))}` : "";
  return `/api/tracks/${trackId}/stream${suffix}`;
}
