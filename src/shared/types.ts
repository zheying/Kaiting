export type ScanStatus = "idle" | "running" | "completed" | "failed";

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  revision?: string;
}

export interface PageOptions {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface TrackPageOptions extends PageOptions {
  favorite?: boolean;
}

export interface Track {
  id: string;
  path: string;
  fileName: string;
  title: string;
  album: string | null;
  albumKey?: string;
  artist: string | null;
  albumArtist: string | null;
  genre: string | null;
  year: number | null;
  trackNo: number | null;
  discNo: number | null;
  duration: number | null;
  bitrate: number | null;
  codec: string | null;
  container: string | null;
  lossless: boolean;
  formatGroup: string;
  hasArtwork: boolean;
  hasLyrics: boolean;
  favorite: boolean;
  addedAt: string;
  updatedAt: string;
}

export interface Album {
  key: string;
  title: string;
  artist: string | null;
  year: number | null;
  trackCount: number;
  duration: number;
  artworkTrackId: string | null;
}

export interface Artist {
  name: string;
  albumCount: number;
  trackCount: number;
  duration: number;
  artworkTrackId: string | null;
}

export interface Playlist {
  id: string;
  name: string;
  description: string | null;
  trackCount: number;
  duration: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistDetail {
  playlist: Playlist;
  tracks: Track[];
  revision: string;
}

export interface ScanOptions {
  force?: boolean;
  prune?: boolean;
}

export interface ScanJob {
  id: string;
  status: ScanStatus;
  startedAt: string | null;
  finishedAt: string | null;
  totalFiles: number;
  scannedFiles: number;
  parsedFiles: number;
  skippedFiles: number;
  force: boolean;
  prune: boolean;
  errorCount: number;
  message: string | null;
}

export interface ScanError {
  id: string;
  scanId: string;
  path: string;
  message: string;
  createdAt: string;
}

export interface LibrarySummary {
  trackCount: number;
  albumCount: number;
  artistCount: number;
  favoriteCount: number;
  playlistCount: number;
  totalDuration: number;
  latestScan: ScanJob | null;
}

export interface LoginRequest {
  password: string;
}

export interface LoginResponse {
  ok: true;
}

export interface SearchResponse {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
}

export interface PagedSearchResponse {
  tracks: Page<Track>;
  albums: Page<Album>;
  artists: Page<Artist>;
}

export interface MetadataStatus {
  enabled: boolean;
  providers: string[];
  mode: "local-first";
  cachedItems: number;
  cacheDir: string;
}
