import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { albumKey, albumTitle, discNumber, discSort, inferredRelease, legacyAlbumKey } from "./album-identity.js";
import { albumMetadataConsensus } from "./album-metadata.js";
import type { Album, AlbumMetadata, AlbumMetadataLookup, AlbumMetadataValues, Artist, LibrarySummary, Page, PageOptions, Playlist, PlaylistDetail, ScanError, ScanJob, ScanOptions, Track, TrackPageOptions } from "../shared/types.js";

type TrackRow = Record<string, unknown>;
type PlaylistOrderResult = { status: "ok"; detail: PlaylistDetail } | { status: "not_found" } | { status: "conflict" };

export interface DatabaseHandle {
  db: Database.Database;
  forUser(userId: string): DatabaseHandle;
  setLibraryRoot(root: string | null): void;
  getLibraryRoot(): string | null;
  catalogRevision(): string;
  getTrack(id: string): Track | null;
  getIndexedTrack(filePath: string): UpsertTrack | null;
  listIndexedPaths(): string[];
  getTrackLyricsPath(id: string): string | null | undefined;
  setTrackLyricsPath(id: string, lyricsPath: string): Track | null;
  listTracks(options?: TrackPageOptions): Track[];
  pageTracks(options?: TrackPageOptions): Page<Track>;
  upsertTrack(track: UpsertTrack): void;
  removeMissingTracks(seenPaths: Set<string>): number;
  listAlbums(limit?: number): Album[];
  pageAlbums(options?: PageOptions): Page<Album>;
  getAlbum(key: string): { album: Album; tracks: Track[] } | null;
  getAlbumMetadata(key: string): AlbumMetadata | null;
  saveAlbumMetadata(key: string, values: AlbumMetadataValues, revision: string): { status: "ok"; metadata: AlbumMetadata } | { status: "not_found" } | { status: "conflict" };
  completeAlbumMetadata(key: string, result: AlbumMetadataLookup, revision: string): "updated" | "skipped" | "conflict";
  listArtists(limit?: number): Artist[];
  pageArtists(options?: PageOptions): Page<Artist>;
  getArtist(name: string): { artist: Artist; albums: Album[]; tracks: Track[] } | null;
  search(q: string): { tracks: Track[]; albums: Album[]; artists: Artist[] };
  toggleFavorite(id: string, favorite: boolean): Track | null;
  createPlaylist(name: string, description?: string | null): Playlist;
  listPlaylists(): Playlist[];
  getPlaylist(id: string): PlaylistDetail | null;
  renamePlaylist(id: string, name: string): Playlist | null;
  deletePlaylist(id: string): boolean;
  addTrackToPlaylist(playlistId: string, trackId: string): PlaylistDetail | null;
  removeTrackFromPlaylist(playlistId: string, trackId: string): PlaylistDetail | null;
  reorderPlaylistTracks(playlistId: string, trackIds: string[], revision: string): PlaylistOrderResult;
  createScanJob(options?: ScanOptions): ScanJob;
  updateScanJob(id: string, patch: Partial<ScanJob>): void;
  recoverInterruptedScans(): number;
  latestScan(): ScanJob | null;
  recordScanError(scanId: string, filePath: string, message: string): void;
  listScanErrors(scanId?: string, limit?: number): ScanError[];
  getMetadataCache(key: string): unknown | null;
  setMetadataCache(key: string, provider: string, payload: unknown): void;
  metadataCacheCount(): number;
  summary(): LibrarySummary;
}

export interface UpsertTrack {
  id: string;
  path: string;
  fileName: string;
  title: string;
  album: string | null;
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
  artworkPath: string | null;
  lyricsPath: string | null;
  size: number;
  mtimeMs: number;
}

function now(): string {
  return new Date().toISOString();
}

function pathWasSeen(filePath: string, seenPaths: Set<string>): boolean {
  if (seenPaths.has(filePath)) return true;
  try {
    return seenPaths.has(fs.realpathSync(filePath));
  } catch {
    return false;
  }
}

function rowToTrack(row: TrackRow): Track {
  return {
    id: String(row.id),
    path: String(row.path),
    fileName: String(row.file_name),
    title: String(row.title),
    album: albumTitle(row.album, row.album_artist, row.path),
    albumKey: albumKey(row.album, row.album_artist, row.artist, row.path),
    artist: row.artist ? String(row.artist) : null,
    albumArtist: row.album_artist ? String(row.album_artist) : null,
    genre: row.genre ? String(row.genre) : null,
    year: row.year === null ? null : Number(row.year),
    trackNo: row.track_no === null ? null : Number(row.track_no),
    discNo: discNumber(row.album, row.album_artist, row.path, row.disc_no),
    discTitle: inferredRelease(row.album, row.album_artist, row.path)?.disc === "bonus" ? "附赠碟" : null,
    duration: row.duration === null ? null : Number(row.duration),
    bitrate: row.bitrate === null ? null : Number(row.bitrate),
    codec: row.codec ? String(row.codec) : null,
    container: row.container ? String(row.container) : null,
    lossless: Boolean(row.lossless),
    formatGroup: String(row.format_group),
    hasArtwork: Boolean(row.artwork_path),
    hasLyrics: Boolean(row.lyrics_path),
    favorite: Boolean(row.favorite),
    addedAt: String(row.added_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToScan(row: TrackRow | undefined): ScanJob | null {
  if (!row) return null;
  return {
    id: String(row.id),
    status: row.status as ScanJob["status"],
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    totalFiles: Number(row.total_files ?? 0),
    scannedFiles: Number(row.scanned_files ?? 0),
    parsedFiles: Number(row.parsed_files ?? 0),
    skippedFiles: Number(row.skipped_files ?? 0),
    force: Boolean(row.force),
    prune: Boolean(row.prune),
    errorCount: Number(row.error_count ?? 0),
    message: row.message ? String(row.message) : null
  };
}

function rowToScanError(row: TrackRow): ScanError {
  return {
    id: String(row.id),
    scanId: String(row.scan_id),
    path: String(row.path),
    message: String(row.message),
    createdAt: String(row.created_at)
  };
}

function rowToAlbum(row: TrackRow): Album {
  const title = String(row.album ?? "未知专辑");
  const artist = row.album_artist ? String(row.album_artist) : row.artist ? String(row.artist) : null;
  return {
    key: String(row.album_key),
    title,
    artist,
    year: row.year === null ? null : Number(row.year),
    trackCount: Number(row.track_count ?? 0),
    genre: row.genre ? String(row.genre) : null,
    discCount: Number(row.disc_count ?? 1),
    duration: Number(row.duration ?? 0),
    artworkTrackId: row.artwork_track_id ? String(row.artwork_track_id) : null
  };
}

function rowToArtist(row: TrackRow): Artist {
  return {
    name: String(row.artist_name),
    albumCount: Number(row.album_count ?? 0),
    trackCount: Number(row.track_count ?? 0),
    duration: Number(row.duration ?? 0),
    artworkTrackId: row.artwork_track_id ? String(row.artwork_track_id) : null
  };
}

function rowToPlaylist(row: TrackRow): Playlist {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    trackCount: Number(row.track_count ?? 0),
    duration: Number(row.duration ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function openDatabase(databasePath: string): DatabaseHandle {
  const db = new Database(databasePath);
  const instanceId = randomUUID();
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // SQLite lower() only folds ASCII; preserve ordinary Unicode substring search.
  db.function("search_lower", { deterministic: true }, (value) => String(value ?? "").toLowerCase());
  db.function("release_album_key", { deterministic: true }, (album, albumArtist, artist, filePath) => albumKey(album, albumArtist, artist, filePath));
  db.function("legacy_album_key", { deterministic: true }, (album, albumArtist, artist, filePath) => legacyAlbumKey(album, albumArtist, artist, filePath));
  db.function("release_album_title", { deterministic: true }, (album, albumArtist, filePath) => albumTitle(album, albumArtist, filePath));
  db.function("release_disc_sort", { deterministic: true }, (album, albumArtist, filePath, taggedDisc) => discSort(album, albumArtist, filePath, taggedDisc));

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      title TEXT NOT NULL,
      album TEXT,
      artist TEXT,
      album_artist TEXT,
      genre TEXT,
      year INTEGER,
      track_no INTEGER,
      disc_no INTEGER,
      duration REAL,
      bitrate INTEGER,
      codec TEXT,
      container TEXT,
      lossless INTEGER NOT NULL DEFAULT 0,
      format_group TEXT NOT NULL,
      artwork_path TEXT,
      lyrics_path TEXT,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
      id UNINDEXED,
      title,
      album,
      artist,
      album_artist,
      genre,
      file_name,
      path
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (playlist_id, track_id)
    );

    CREATE TABLE IF NOT EXISTS scan_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      total_files INTEGER NOT NULL DEFAULT 0,
      scanned_files INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      message TEXT
    );

    CREATE TABLE IF NOT EXISTS scan_errors (
      id TEXT PRIMARY KEY,
      scan_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scan_errors_scan_id ON scan_errors(scan_id);

    CREATE TABLE IF NOT EXISTS metadata_cache (
      key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS album_metadata_overrides (
      library_root TEXT NOT NULL,
      album_key TEXT NOT NULL,
      year INTEGER,
      genre TEXT,
      PRIMARY KEY (library_root, album_key)
    );
    CREATE TABLE IF NOT EXISTS album_metadata_enrichment (
      library_root TEXT NOT NULL,
      album_key TEXT NOT NULL,
      manual INTEGER NOT NULL DEFAULT 0,
      year INTEGER,
      genre TEXT,
      release_id TEXT,
      matched_at TEXT,
      PRIMARY KEY (library_root, album_key)
    );
    INSERT OR IGNORE INTO album_metadata_enrichment(library_root, album_key, manual)
      SELECT library_root, album_key, 1 FROM album_metadata_overrides;
  `);

  const enrichmentColumns = new Set((db.pragma("table_info(album_metadata_enrichment)") as { name: string }[]).map((column) => column.name));
  if (!enrichmentColumns.has("source_ids")) db.exec("ALTER TABLE album_metadata_enrichment ADD COLUMN source_ids TEXT");

  // Additive migration preserves scan history from versions before incremental scans.
  const scanColumns = new Set((db.pragma("table_info(scan_jobs)") as { name: string }[]).map((column) => column.name));
  for (const column of ["parsed_files", "skipped_files", "force", "prune"]) {
    if (!scanColumns.has(column)) db.exec(`ALTER TABLE scan_jobs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }

  const playlistColumns = new Set((db.pragma("table_info(playlists)") as { name: string }[]).map((column) => column.name));
  if (!playlistColumns.has("owner_id")) db.exec("ALTER TABLE playlists ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'admin'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_favorites (
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, track_id)
    );
    CREATE INDEX IF NOT EXISTS idx_playlists_owner ON playlists(owner_id);
    INSERT OR IGNORE INTO user_favorites(user_id, track_id) SELECT 'admin', id FROM tracks WHERE favorite = 1;
  `);
  // Paging revisions describe library data, not session heartbeats or player preferences.
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_revisions (key TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO library_revisions(key) VALUES ('tracks');
    CREATE TRIGGER IF NOT EXISTS tracks_revision_insert AFTER INSERT ON tracks BEGIN UPDATE library_revisions SET version = version + 1 WHERE key = 'tracks'; END;
    CREATE TRIGGER IF NOT EXISTS tracks_revision_update AFTER UPDATE ON tracks BEGIN UPDATE library_revisions SET version = version + 1 WHERE key = 'tracks'; END;
    CREATE TRIGGER IF NOT EXISTS tracks_revision_delete AFTER DELETE ON tracks BEGIN UPDATE library_revisions SET version = version + 1 WHERE key = 'tracks'; END;
    CREATE TRIGGER IF NOT EXISTS album_metadata_revision_insert AFTER INSERT ON album_metadata_overrides BEGIN UPDATE library_revisions SET version = version + 1 WHERE key = 'tracks'; END;
    CREATE TRIGGER IF NOT EXISTS album_metadata_revision_update AFTER UPDATE ON album_metadata_overrides BEGIN UPDATE library_revisions SET version = version + 1 WHERE key = 'tracks'; END;
    CREATE TRIGGER IF NOT EXISTS album_metadata_revision_delete AFTER DELETE ON album_metadata_overrides BEGIN UPDATE library_revisions SET version = version + 1 WHERE key = 'tracks'; END;
    CREATE TRIGGER IF NOT EXISTS enrichment_revision_insert AFTER INSERT ON album_metadata_enrichment BEGIN UPDATE library_revisions SET version = version + 1 WHERE key = 'tracks'; END;
    CREATE TRIGGER IF NOT EXISTS enrichment_revision_update AFTER UPDATE ON album_metadata_enrichment BEGIN UPDATE library_revisions SET version = version + 1 WHERE key = 'tracks'; END;
    CREATE TRIGGER IF NOT EXISTS enrichment_revision_delete AFTER DELETE ON album_metadata_enrichment BEGIN UPDATE library_revisions SET version = version + 1 WHERE key = 'tracks'; END;
    CREATE TRIGGER IF NOT EXISTS favorites_revision_insert AFTER INSERT ON user_favorites BEGIN
      INSERT INTO library_revisions(key, version) VALUES ('favorites:' || NEW.user_id, 1) ON CONFLICT(key) DO UPDATE SET version = version + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS favorites_revision_delete AFTER DELETE ON user_favorites BEGIN
      INSERT INTO library_revisions(key, version) VALUES ('favorites:' || OLD.user_id, 1) ON CONFLICT(key) DO UPDATE SET version = version + 1;
    END;
  `);
  let activeRoot: string | null = null;
  db.function("active_library_path", (candidate) => {
    if (!activeRoot) return 1;
    const relative = path.relative(activeRoot, String(candidate));
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? 1 : 0;
  });
  db.function("active_library_root", () => activeRoot ?? "");
  // Apply display overrides at read time; the scanner always retains the original tags.
  db.exec(`CREATE TEMP VIEW library_tracks AS
    SELECT t.rowid AS source_rowid, t.id, t.path, t.file_name, t.title, t.album, t.artist, t.album_artist,
      COALESCE(m.genre, NULLIF(TRIM(t.genre), ''), a.genre) AS genre, COALESCE(m.year, t.year, a.year) AS year,
      t.track_no, t.disc_no, t.duration, t.bitrate, t.codec, t.container, t.lossless, t.format_group,
      t.artwork_path, t.lyrics_path, t.size, t.mtime_ms, t.favorite, t.added_at, t.updated_at
    FROM tracks t LEFT JOIN album_metadata_overrides m
      ON m.library_root = active_library_root() AND m.album_key = release_album_key(t.album, t.album_artist, t.artist, t.path)
    LEFT JOIN album_metadata_enrichment a
      ON a.library_root = active_library_root() AND a.album_key = release_album_key(t.album, t.album_artist, t.artist, t.path) AND a.manual = 0
    WHERE active_library_path(t.path) = 1`);

  const deleteFts = db.prepare("DELETE FROM tracks_fts WHERE id = ?");
  const insertFts = db.prepare(`
    INSERT INTO tracks_fts (rowid, id, title, album, artist, album_artist, genre, file_name, path)
    VALUES (
      (SELECT rowid FROM tracks WHERE id = @id),
      @id,
      @title,
      COALESCE(@album, ''),
      COALESCE(@artist, ''),
      COALESCE(@albumArtist, ''),
      COALESCE(@genre, ''),
      @fileName,
      @path
    )
  `);

  const upsert = db.prepare(`
    INSERT INTO tracks (
      id, path, file_name, title, album, artist, album_artist, genre, year, track_no, disc_no,
      duration, bitrate, codec, container, lossless, format_group, artwork_path, lyrics_path,
      size, mtime_ms, added_at, updated_at
    )
    VALUES (
      @id, @path, @fileName, @title, @album, @artist, @albumArtist, @genre, @year, @trackNo, @discNo,
      @duration, @bitrate, @codec, @container, @lossless, @formatGroup, @artworkPath, @lyricsPath,
      @size, @mtimeMs, @timestamp, @timestamp
    )
    ON CONFLICT(path) DO UPDATE SET
      file_name = excluded.file_name,
      title = excluded.title,
      album = excluded.album,
      artist = excluded.artist,
      album_artist = excluded.album_artist,
      genre = excluded.genre,
      year = excluded.year,
      track_no = excluded.track_no,
      disc_no = excluded.disc_no,
      duration = excluded.duration,
      bitrate = excluded.bitrate,
      codec = excluded.codec,
      container = excluded.container,
      lossless = excluded.lossless,
      format_group = excluded.format_group,
      artwork_path = excluded.artwork_path,
      lyrics_path = excluded.lyrics_path,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      updated_at = excluded.updated_at
  `);

  const txUpsert = db.transaction((track: UpsertTrack) => {
    upsert.run({ ...track, lossless: track.lossless ? 1 : 0, timestamp: now() });
    deleteFts.run(track.id);
    insertFts.run(track);
  });

  function forUser(userId: string): DatabaseHandle {
  const favoriteLookup = db.prepare("SELECT 1 FROM user_favorites WHERE user_id = ? AND track_id = ?");
  const userTrack = (row: TrackRow): Track => ({ ...rowToTrack(row), favorite: Boolean(favoriteLookup.get(userId, row.id)) });
  function trackQuery(options: TrackPageOptions) {
    const favoriteClause = options.favorite ? "EXISTS (SELECT 1 FROM user_favorites uf WHERE uf.track_id = tracks.id AND uf.user_id = @userId)" : "1 = 1";
    if (options.q?.trim()) {
      // Treat input as ordinary words, never as FTS operators or column names.
      const terms = options.q.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
      if (terms.length === 0) return { from: "library_tracks tracks", where: "0 = 1", order: "tracks.id", params: {} };
      const query = terms.map((term) => `"${term}"*`).join(" AND ");
      return {
        from: "library_tracks tracks",
        where: `(tracks.source_rowid IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH @q) OR instr(search_lower(tracks.genre), @genreQuery) > 0) AND ${favoriteClause}`,
        order: "COALESCE((SELECT rank FROM tracks_fts WHERE rowid = tracks.source_rowid AND tracks_fts MATCH @q), 0), tracks.id",
        params: { q: query, genreQuery: options.q.trim().toLowerCase(), ...(options.favorite ? { userId } : {}) }
      };
    }
    return {
      from: "library_tracks tracks",
      where: favoriteClause,
      order: "release_album_title(album, album_artist, path) COLLATE NOCASE, release_album_key(album, album_artist, artist, path), release_disc_sort(album, album_artist, path, disc_no), track_no, title COLLATE NOCASE, tracks.id",
      params: options.favorite ? { userId } : {}
    };
  }

  function listTracks(options: TrackPageOptions = {}): Track[] {
    const limit = options.limit ?? 80;
    const offset = options.offset ?? 0;
    const query = trackQuery(options);
    return db.prepare(`
      SELECT tracks.* FROM ${query.from}
      WHERE ${query.where}
      ORDER BY ${query.order}
      LIMIT @limit OFFSET @offset
    `).all({ ...query.params, limit, offset }).map((row) => userTrack(row as TrackRow));
  }

  function pageRevision(): string {
    const revisions = db.prepare("SELECT key, version FROM library_revisions WHERE key IN ('tracks', ?)").all(`favorites:${userId}`);
    return createHash("sha256").update(JSON.stringify([instanceId, activeRoot, revisions])).digest("hex");
  }

  const pageTracks = db.transaction((options: TrackPageOptions = {}): Page<Track> => {
    const query = trackQuery(options);
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM ${query.from} WHERE ${query.where}`)
      .get(query.params) as { total: number };
    const items = listTracks(options);
    return { items, total, limit: options.limit ?? 80, offset: options.offset ?? 0, revision: pageRevision() };
  });

  const albumSelect = `
      SELECT
        release_album_key(album, album_artist, artist, path) AS album_key,
        MIN(COALESCE(release_album_title(album, album_artist, path), '未知专辑')) AS album,
        CASE WHEN COUNT(DISTINCT lower(COALESCE(album_artist, artist))) > 1 THEN '多位艺人'
          ELSE MIN(COALESCE(album_artist, artist)) END AS album_artist,
        MIN(artist) AS artist,
        MIN(year) AS year,
        MIN(NULLIF(TRIM(genre), '')) AS genre,
        COUNT(*) AS track_count,
        COUNT(DISTINCT release_disc_sort(album, album_artist, path, disc_no)) AS disc_count,
        COALESCE(SUM(duration), 0) AS duration,
        MIN(CASE WHEN artwork_path IS NOT NULL THEN id END) AS artwork_track_id,
        MAX(added_at) AS newest_added_at
      FROM library_tracks
      GROUP BY album_key
  `;
  const albumFilter = `(@q = '' OR instr(search_lower(album), @q) > 0 OR instr(search_lower(album_artist), @q) > 0 OR instr(search_lower(genre), @q) > 0 OR album_key IN (
    SELECT release_album_key(album, album_artist, artist, path) FROM library_tracks
    WHERE instr(search_lower(album), @q) > 0 OR instr(search_lower(album_artist), @q) > 0 OR instr(search_lower(artist), @q) > 0
  ))`;

  const artistSelect = `
      SELECT
        COALESCE(album_artist, artist, '未知艺人') AS artist_name,
        COUNT(DISTINCT release_album_key(album, album_artist, artist, path)) AS album_count,
        COUNT(*) AS track_count,
        COALESCE(SUM(duration), 0) AS duration,
        MIN(CASE WHEN artwork_path IS NOT NULL THEN id END) AS artwork_track_id
      FROM library_tracks
      GROUP BY artist_name
  `;
  const artistFilter = "(@q = '' OR instr(search_lower(artist_name), @q) > 0)";

  const pageAlbums = db.transaction((options: PageOptions = {}): Page<Album> => {
    const q = options.q?.trim().toLowerCase() ?? "";
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM (${albumSelect}) WHERE ${albumFilter}`)
      .get({ q }) as { total: number };
    const items = db.prepare(`
      SELECT * FROM (${albumSelect}) WHERE ${albumFilter}
      ORDER BY newest_added_at DESC, album_key
      LIMIT @limit OFFSET @offset
    `).all({ q, limit, offset }).map((row) => rowToAlbum(row as TrackRow));
    return { items, total, limit, offset, revision: pageRevision() };
  });

  const pageArtists = db.transaction((options: PageOptions = {}): Page<Artist> => {
    const q = options.q?.trim().toLowerCase() ?? "";
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM (${artistSelect}) WHERE ${artistFilter}`)
      .get({ q }) as { total: number };
    const items = db.prepare(`
      SELECT * FROM (${artistSelect}) WHERE ${artistFilter}
      ORDER BY artist_name COLLATE NOCASE, artist_name
      LIMIT @limit OFFSET @offset
    `).all({ q, limit, offset }).map((row) => rowToArtist(row as TrackRow));
    return { items, total, limit, offset, revision: pageRevision() };
  });

  function listAlbums(limit = 200): Album[] {
    return pageAlbums({ limit }).items;
  }

  function listArtists(limit = 200): Artist[] {
    return pageArtists({ limit }).items;
  }

  const getAlbum = db.transaction((requestedKey: string): { album: Album; tracks: Track[] } | null => {
    let key = requestedKey;
    let row = db.prepare(`SELECT * FROM (${albumSelect}) WHERE album_key = ?`).get(key) as TrackRow | undefined;
    if (!row && (key.includes("::") || key.startsWith("folder:"))) {
      // Old per-performer and per-disc URLs resolve to the complete release.
      // If it names more than one release, do not silently select or merge them.
      const matches = db.prepare(`
        SELECT DISTINCT release_album_key(album, album_artist, artist, path) AS album_key FROM library_tracks
        WHERE legacy_album_key(album, album_artist, artist, path) = @key
          OR lower(COALESCE(album, '未知专辑')) || '::' || lower(COALESCE(album_artist, artist, '未知艺人')) = @key
        LIMIT 2
      `).all({ key }) as { album_key: string }[];
      if (matches.length !== 1) return null;
      key = matches[0].album_key;
      row = db.prepare(`SELECT * FROM (${albumSelect}) WHERE album_key = ?`).get(key) as TrackRow | undefined;
    }
    if (!row) return null;
    const tracks = db.prepare(`
      SELECT * FROM library_tracks WHERE release_album_key(album, album_artist, artist, path) = ?
      ORDER BY release_disc_sort(album, album_artist, path, disc_no), track_no, title COLLATE NOCASE, id
    `).all(key).map((track) => userTrack(track as TrackRow));
    return { album: rowToAlbum(row), tracks };
  });

  const getAlbumMetadata = db.transaction((requestedKey: string): AlbumMetadata | null => {
    const detail = getAlbum(requestedKey);
    if (!detail) return null;
    const key = detail.album.key;
    const original = db.prepare(`SELECT MIN(year) AS year, MIN(NULLIF(TRIM(genre), '')) AS genre FROM tracks
      WHERE active_library_path(path) = 1 AND release_album_key(album, album_artist, artist, path) = ?`).get(key) as AlbumMetadataValues;
    const overrides = (db.prepare("SELECT year, genre FROM album_metadata_overrides WHERE library_root = ? AND album_key = ?")
      .get(activeRoot ?? "", key) as AlbumMetadataValues | undefined) ?? { year: null, genre: null };
    const enrichment = db.prepare("SELECT manual, year, genre, release_id, matched_at, source_ids FROM album_metadata_enrichment WHERE library_root = ? AND album_key = ?")
      .get(activeRoot ?? "", key) as (AlbumMetadataValues & { manual: number; release_id: string | null; matched_at: string | null; source_ids: string | null }) | undefined;
    const autoFillBlocked = Boolean(enrichment?.manual || overrides.year !== null || overrides.genre !== null);
    let sourceIds: { year?: string[]; genre?: string[] } = {};
    try { sourceIds = JSON.parse(enrichment?.source_ids || "{}") ?? {}; } catch { /* Legacy single-source records remain readable. */ }
    const sources = (field: "year" | "genre") => {
      const ids = sourceIds[field];
      return (Array.isArray(ids) ? ids : enrichment?.[field] != null && enrichment.release_id ? [enrichment.release_id] : [])
        .filter((id) => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
        .map((id) => `https://musicbrainz.org/release/${id}`);
    };
    const automatic = enrichment?.release_id && enrichment.matched_at && !enrichment.manual ? {
      year: enrichment.year, genre: enrichment.genre, sourceUrl: `https://musicbrainz.org/release/${enrichment.release_id}`, matchedAt: enrichment.matched_at,
      sources: { year: sources("year"), genre: sources("genre") }
    } : null;
    // A remote lookup must not commit against a different set of songs or a changed edition.
    const identity = detail.tracks.map(({ id, path, title, artist, discNo, trackNo, duration, year, genre }) => [id, path, title, artist, discNo, trackNo, duration, year, genre]);
    const revision = createHash("sha256").update(JSON.stringify([activeRoot, detail.album, identity, original, overrides, enrichment ?? null])).digest("hex");
    return { album: detail.album, original, overrides, revision, automatic, autoFillBlocked };
  });

  const saveAlbumMetadata: DatabaseHandle["saveAlbumMetadata"] = db.transaction((key: string, values: AlbumMetadataValues, revision: string) => {
    const current = getAlbumMetadata(key);
    if (!current) return { status: "not_found" as const };
    if (current.revision !== revision) return { status: "conflict" as const };
    // Remember an explicit edit, including restoring empty scan values, across scans and restarts.
    db.prepare(`INSERT INTO album_metadata_enrichment(library_root, album_key, manual) VALUES (?, ?, 1)
      ON CONFLICT(library_root, album_key) DO UPDATE SET manual = 1, year = NULL, genre = NULL, release_id = NULL, matched_at = NULL, source_ids = NULL`)
      .run(activeRoot ?? "", current.album.key);
    const year = values.year === current.original.year ? null : values.year;
    const genre = values.genre?.trim() || null;
    const overrideGenre = genre === current.original.genre ? null : genre;
    if (year === null && overrideGenre === null) {
      db.prepare("DELETE FROM album_metadata_overrides WHERE library_root = ? AND album_key = ?").run(activeRoot ?? "", current.album.key);
    } else {
      db.prepare(`INSERT INTO album_metadata_overrides (library_root, album_key, year, genre) VALUES (?, ?, ?, ?)
        ON CONFLICT(library_root, album_key) DO UPDATE SET year = excluded.year, genre = excluded.genre`)
        .run(activeRoot ?? "", current.album.key, year, overrideGenre);
    }
    return { status: "ok" as const, metadata: getAlbumMetadata(current.album.key)! };
  });

  const completeAlbumMetadata: DatabaseHandle["completeAlbumMetadata"] = db.transaction((key, result, revision) => {
    const current = getAlbumMetadata(key);
    if (!current || current.revision !== revision) return "conflict";
    if (current.autoFillBlocked) return "skipped";
    const candidate = albumMetadataConsensus(current.album, result);
    if (!candidate) return "skipped";
    const year = current.album.year === null && candidate.year !== null && Number.isInteger(candidate.year) && candidate.year >= 1000 && candidate.year <= 9999 ? candidate.year : null;
    const genre = !current.album.genre?.trim() && candidate.genre?.trim() && candidate.genre.length <= 80 && !/[\u0000-\u001f\u007f]/.test(candidate.genre) ? candidate.genre.trim() : null;
    if (year === null && genre === null) return "skipped";
    const sourceIds = {
      year: year !== null ? candidate.sources.year : (current.automatic?.sources?.year ?? []).map((url) => url.slice(url.lastIndexOf("/") + 1)),
      genre: genre !== null ? candidate.sources.genre : (current.automatic?.sources?.genre ?? []).map((url) => url.slice(url.lastIndexOf("/") + 1))
    };
    const representative = sourceIds.year[0] ?? sourceIds.genre[0];
    db.prepare(`INSERT INTO album_metadata_enrichment(library_root, album_key, year, genre, release_id, matched_at, source_ids) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(library_root, album_key) DO UPDATE SET year = excluded.year, genre = excluded.genre, release_id = excluded.release_id, matched_at = excluded.matched_at, source_ids = excluded.source_ids`)
      .run(activeRoot ?? "", current.album.key, year ?? current.automatic?.year ?? null, genre ?? current.automatic?.genre ?? null, representative, now(), JSON.stringify(sourceIds));
    return "updated";
  });

  function playlistSelect(where = "", params: unknown[] = []): Playlist[] {
    return db.prepare(`
      SELECT p.*,
        COUNT(t.id) AS track_count,
        COALESCE(SUM(t.duration), 0) AS duration
      FROM playlists p
      LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
      LEFT JOIN library_tracks t ON t.id = pt.track_id
      ${where ? `${where} AND` : "WHERE"} p.owner_id = ?
      GROUP BY p.id
      ORDER BY p.updated_at DESC, p.id
    `).all(...params, userId).map((row) => rowToPlaylist(row as TrackRow));
  }

  const getPlaylist = db.transaction((id: string): PlaylistDetail | null => {
    const playlist = playlistSelect("WHERE p.id = ?", [id])[0];
    if (!playlist) return null;
    const tracks = db.prepare(`
      SELECT t.* FROM playlist_tracks pt
      JOIN library_tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position, pt.track_id
    `).all(id).map((row) => userTrack(row as TrackRow));
    const revision = createHash("sha256")
      .update(JSON.stringify([id, playlist.name, playlist.description, tracks.map((track) => track.id)]))
      .digest("hex");
    return { playlist, tracks, revision };
  });

  function writePlaylistOrder(playlistId: string, trackIds: string[]): void {
    // Reorder the visible subset in its existing slots, retaining songs from other roots.
    const all = db.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, track_id").all(playlistId) as { track_id: string }[];
    const visible = new Set(trackIds);
    let cursor = 0;
    const merged = all.map((row) => visible.has(row.track_id) ? trackIds[cursor++] : row.track_id);
    const update = db.prepare("UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?");
    merged.forEach((trackId, index) => update.run(index + 1, playlistId, trackId));
  }

  const renamePlaylist = db.transaction((id: string, name: string): Playlist | null => {
    const current = getPlaylist(id);
    if (!current) return null;
    if (current.playlist.name !== name) {
      db.prepare("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), id);
    }
    return playlistSelect("WHERE p.id = ?", [id])[0];
  });

  const addTrackToPlaylist = db.transaction((playlistId: string, trackId: string): PlaylistDetail | null => {
    const current = getPlaylist(playlistId);
    if (!current || !db.prepare("SELECT id FROM library_tracks WHERE id = ?").get(trackId)) return null;
    if (current.tracks.some((track) => track.id === trackId)) return current;
    // Compact legacy gaps before appending, so every successful mutation keeps positions contiguous.
    writePlaylistOrder(playlistId, current.tracks.map((track) => track.id));
    const total = db.prepare("SELECT COUNT(*) AS count FROM playlist_tracks WHERE playlist_id = ?").get(playlistId) as { count: number };
    db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)")
      .run(playlistId, trackId, total.count + 1, now());
    db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now(), playlistId);
    return getPlaylist(playlistId);
  });

  const removeTrackFromPlaylist = db.transaction((playlistId: string, trackId: string): PlaylistDetail | null => {
    const current = getPlaylist(playlistId);
    if (!current) return null;
    if (!current.tracks.some((track) => track.id === trackId)) return current;
    db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?").run(playlistId, trackId);
    writePlaylistOrder(playlistId, current.tracks.filter((track) => track.id !== trackId).map((track) => track.id));
    db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now(), playlistId);
    return getPlaylist(playlistId);
  });

  const reorderPlaylistTracks = db.transaction((playlistId: string, trackIds: string[], revision: string): PlaylistOrderResult => {
    const current = getPlaylist(playlistId);
    if (!current) return { status: "not_found" };
    const members = new Set(current.tracks.map((track) => track.id));
    if (revision !== current.revision || trackIds.length !== members.size
      || new Set(trackIds).size !== trackIds.length || trackIds.some((id) => !members.has(id))) {
      return { status: "conflict" };
    }
    if (trackIds.some((id, index) => id !== current.tracks[index].id)) {
      writePlaylistOrder(playlistId, trackIds);
      db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now(), playlistId);
    }
    return { status: "ok", detail: getPlaylist(playlistId)! };
  });

  return {
    db,
    forUser,
    setLibraryRoot(root) { activeRoot = root ? path.resolve(root) : null; },
    getLibraryRoot() { return activeRoot; },
    catalogRevision() {
      const version = db.prepare("SELECT version FROM library_revisions WHERE key = 'tracks'").get();
      return createHash("sha256").update(JSON.stringify([instanceId, activeRoot, version])).digest("hex");
    },
    getIndexedTrack(filePath) {
      const row = db.prepare("SELECT * FROM tracks WHERE path = ? AND active_library_path(path) = 1").get(filePath) as TrackRow | undefined;
      if (!row) return null;
      return {
        ...rowToTrack(row),
        artworkPath: row.artwork_path ? String(row.artwork_path) : null,
        lyricsPath: row.lyrics_path ? String(row.lyrics_path) : null,
        size: Number(row.size),
        mtimeMs: Number(row.mtime_ms)
      };
    },
    listIndexedPaths() {
      return (db.prepare("SELECT path FROM library_tracks ORDER BY path").all() as { path: string }[]).map((row) => row.path);
    },
    getTrack(id) {
      const row = db.prepare("SELECT * FROM library_tracks WHERE id = ?").get(id) as TrackRow | undefined;
      return row ? userTrack(row) : null;
    },
    getTrackLyricsPath(id) {
      const row = db.prepare("SELECT lyrics_path FROM library_tracks WHERE id = ?").get(id) as { lyrics_path?: string | null } | undefined;
      if (!row) return undefined;
      return row.lyrics_path ?? null;
    },
    setTrackLyricsPath(id, lyricsPath) {
      db.prepare("UPDATE tracks SET lyrics_path = ?, updated_at = ? WHERE id = ?").run(lyricsPath, now(), id);
      return this.getTrack(id);
    },
    listTracks,
    pageTracks,
    upsertTrack(track) {
      txUpsert(track);
    },
    removeMissingTracks(seenPaths) {
      const rows = db.prepare("SELECT id, path FROM library_tracks").all() as { id: string; path: string }[];
      const missing = rows.filter((row) => !pathWasSeen(row.path, seenPaths));
      const tx = db.transaction(() => {
        const delFts = db.prepare("DELETE FROM tracks_fts WHERE id = ?");
        const delTrack = db.prepare("DELETE FROM tracks WHERE id = ?");
        for (const row of missing) {
          delFts.run(row.id);
          delTrack.run(row.id);
        }
      });
      tx();
      return missing.length;
    },
    listAlbums,
    pageAlbums,
    getAlbum,
    getAlbumMetadata,
    saveAlbumMetadata,
    completeAlbumMetadata,
    listArtists,
    pageArtists,
    getArtist(name) {
      const row = db.prepare(`SELECT * FROM (${artistSelect}) WHERE artist_name = ?`).get(name) as TrackRow | undefined;
      if (!row) return null;
      const artist = rowToArtist(row);
      const albums = db.prepare(`
        SELECT * FROM (${albumSelect})
        WHERE album_key IN (
          SELECT release_album_key(album, album_artist, artist, path)
          FROM library_tracks WHERE COALESCE(album_artist, artist, '未知艺人') = ?
        )
        ORDER BY newest_added_at DESC, album_key
      `).all(name).map((album) => rowToAlbum(album as TrackRow));
      const tracks = db.prepare(`
        SELECT * FROM library_tracks
        WHERE COALESCE(album_artist, artist, '未知艺人') = ?
        ORDER BY release_album_title(album, album_artist, path) COLLATE NOCASE, release_album_key(album, album_artist, artist, path), release_disc_sort(album, album_artist, path, disc_no), track_no, title COLLATE NOCASE, id
      `).all(name).map((row) => userTrack(row as TrackRow));
      return { artist, albums, tracks };
    },
    search(q) {
      const tracks = listTracks({ q, limit: 25 });
      const albums = pageAlbums({ q, limit: 12 }).items;
      const artists = pageArtists({ q, limit: 12 }).items;
      return { tracks, albums, artists };
    },
    toggleFavorite(id, favorite) {
      if (!this.getTrack(id)) return null;
      db.transaction(() => {
        if (favorite) db.prepare("INSERT OR IGNORE INTO user_favorites(user_id, track_id) VALUES (?, ?)").run(userId, id);
        else db.prepare("DELETE FROM user_favorites WHERE user_id = ? AND track_id = ?").run(userId, id);
        if (userId === "admin") db.prepare("UPDATE tracks SET favorite = ?, updated_at = ? WHERE id = ?").run(favorite ? 1 : 0, now(), id);
      })();
      return this.getTrack(id);
    },
    createPlaylist(name, description = null) {
      const id = randomUUID();
      const timestamp = now();
      db.prepare("INSERT INTO playlists (id, name, description, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, name, description, timestamp, timestamp, userId);
      return playlistSelect("WHERE p.id = ?", [id])[0];
    },
    listPlaylists() {
      return playlistSelect();
    },
    getPlaylist,
    renamePlaylist: renamePlaylist.immediate,
    deletePlaylist(id) {
      return db.prepare("DELETE FROM playlists WHERE id = ? AND owner_id = ?").run(id, userId).changes > 0;
    },
    addTrackToPlaylist: addTrackToPlaylist.immediate,
    removeTrackFromPlaylist: removeTrackFromPlaylist.immediate,
    reorderPlaylistTracks: reorderPlaylistTracks.immediate,
    createScanJob(options = {}) {
      const job: ScanJob = {
        id: randomUUID(),
        status: "running",
        startedAt: now(),
        finishedAt: null,
        totalFiles: 0,
        scannedFiles: 0,
        parsedFiles: 0,
        skippedFiles: 0,
        force: options.force === true,
        prune: options.prune === true,
        errorCount: 0,
        message: null
      };
      db.prepare(`
        INSERT INTO scan_jobs (id, status, started_at, total_files, scanned_files, parsed_files, skipped_files, force, prune, error_count, message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(job.id, job.status, job.startedAt, 0, 0, 0, 0, job.force ? 1 : 0, job.prune ? 1 : 0, 0, null);
      return job;
    },
    updateScanJob(id, patch) {
      const current = rowToScan(db.prepare("SELECT * FROM scan_jobs WHERE id = ?").get(id) as TrackRow | undefined);
      if (!current) return;
      const next = { ...current, ...patch };
      db.prepare(`
        UPDATE scan_jobs
        SET status = ?, started_at = ?, finished_at = ?, total_files = ?, scanned_files = ?, parsed_files = ?, skipped_files = ?, force = ?, prune = ?, error_count = ?, message = ?
        WHERE id = ?
      `).run(next.status, next.startedAt, next.finishedAt, next.totalFiles, next.scannedFiles, next.parsedFiles, next.skippedFiles, next.force ? 1 : 0, next.prune ? 1 : 0, next.errorCount, next.message, id);
    },
    recoverInterruptedScans() {
      return db.prepare(`
        UPDATE scan_jobs SET status = 'failed', finished_at = ?, error_count = error_count + 1,
          message = '上次扫描因服务中断而停止，已保留索引。请重新扫描，未变化的已处理文件会跳过。'
        WHERE status = 'running'
      `).run(now()).changes;
    },
    latestScan() {
      return rowToScan(db.prepare("SELECT * FROM scan_jobs ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as TrackRow | undefined);
    },
    recordScanError(scanId, filePath, message) {
      db.prepare("INSERT INTO scan_errors (id, scan_id, path, message, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(randomUUID(), scanId, filePath, message, now());
    },
    listScanErrors(scanId, limit = 100) {
      const latest = scanId ?? this.latestScan()?.id;
      if (!latest) return [];
      return db.prepare(`
        SELECT * FROM scan_errors
        WHERE scan_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(latest, limit).map((row) => rowToScanError(row as TrackRow));
    },
    getMetadataCache(key) {
      const row = db.prepare("SELECT payload FROM metadata_cache WHERE key = ?").get(key) as { payload?: string } | undefined;
      if (!row?.payload) return null;
      try {
        return JSON.parse(row.payload) as unknown;
      } catch {
        return null;
      }
    },
    setMetadataCache(key, provider, payload) {
      const timestamp = now();
      db.prepare(`
        INSERT INTO metadata_cache (key, provider, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          provider = excluded.provider,
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `).run(key, provider, JSON.stringify(payload), timestamp, timestamp);
    },
    metadataCacheCount() {
      const row = db.prepare("SELECT COUNT(*) AS count FROM metadata_cache").get() as { count: number };
      return Number(row.count ?? 0);
    },
    summary() {
      const counts = db.prepare(`
        SELECT
          COUNT(*) AS track_count,
          COUNT(DISTINCT release_album_key(album, album_artist, artist, path)) AS album_count,
          COUNT(DISTINCT COALESCE(album_artist, artist, '未知艺人')) AS artist_count,
          SUM(CASE WHEN EXISTS (SELECT 1 FROM user_favorites uf WHERE uf.track_id = library_tracks.id AND uf.user_id = @userId) THEN 1 ELSE 0 END) AS favorite_count,
          COALESCE(SUM(duration), 0) AS total_duration
        FROM library_tracks
      `).get({ userId }) as TrackRow;
      const playlistCount = db.prepare("SELECT COUNT(*) AS count FROM playlists WHERE owner_id = ?").get(userId) as { count: number };
      return {
        trackCount: Number(counts.track_count ?? 0),
        albumCount: Number(counts.album_count ?? 0),
        artistCount: Number(counts.artist_count ?? 0),
        favoriteCount: Number(counts.favorite_count ?? 0),
        playlistCount: Number(playlistCount.count ?? 0),
        totalDuration: Number(counts.total_duration ?? 0),
        latestScan: this.latestScan()
      };
    }
  };
  }
  return forUser("admin");
}

export function makeAlbumKey(album: string | null, albumArtist: string | null, artist: string | null): string {
  return albumKey(album, albumArtist, artist);
}
