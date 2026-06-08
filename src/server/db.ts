import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Album, Artist, LibrarySummary, Playlist, ScanError, ScanJob, Track } from "../shared/types.js";

type TrackRow = Record<string, unknown>;

export interface DatabaseHandle {
  db: Database.Database;
  getTrack(id: string): Track | null;
  listTracks(options?: { q?: string; limit?: number; offset?: number; favorite?: boolean }): Track[];
  upsertTrack(track: UpsertTrack): void;
  removeMissingTracks(seenPaths: Set<string>): number;
  listAlbums(limit?: number): Album[];
  getAlbum(key: string): { album: Album; tracks: Track[] } | null;
  listArtists(limit?: number): Artist[];
  getArtist(name: string): { artist: Artist; albums: Album[]; tracks: Track[] } | null;
  search(q: string): { tracks: Track[]; albums: Album[]; artists: Artist[] };
  toggleFavorite(id: string, favorite: boolean): Track | null;
  createPlaylist(name: string, description?: string | null): Playlist;
  listPlaylists(): Playlist[];
  getPlaylist(id: string): { playlist: Playlist; tracks: Track[] } | null;
  addTrackToPlaylist(playlistId: string, trackId: string): void;
  removeTrackFromPlaylist(playlistId: string, trackId: string): void;
  createScanJob(): ScanJob;
  updateScanJob(id: string, patch: Partial<ScanJob>): void;
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

function rowToTrack(row: TrackRow): Track {
  return {
    id: String(row.id),
    path: String(row.path),
    fileName: String(row.file_name),
    title: String(row.title),
    album: row.album ? String(row.album) : null,
    artist: row.artist ? String(row.artist) : null,
    albumArtist: row.album_artist ? String(row.album_artist) : null,
    genre: row.genre ? String(row.genre) : null,
    year: row.year === null ? null : Number(row.year),
    trackNo: row.track_no === null ? null : Number(row.track_no),
    discNo: row.disc_no === null ? null : Number(row.disc_no),
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

function albumKey(album: unknown, albumArtist: unknown, artist: unknown): string {
  return `${String(album ?? "未知专辑").toLowerCase()}::${String(albumArtist ?? artist ?? "未知艺人").toLowerCase()}`;
}

export function openDatabase(databasePath: string): DatabaseHandle {
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

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
  `);

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

  function listTracks(options: { q?: string; limit?: number; offset?: number; favorite?: boolean } = {}): Track[] {
    const limit = options.limit ?? 80;
    const offset = options.offset ?? 0;
    if (options.q) {
      return db.prepare(`
        SELECT tracks.*
        FROM tracks_fts
        JOIN tracks ON tracks.rowid = tracks_fts.rowid
        WHERE tracks_fts MATCH @q
        ORDER BY rank
        LIMIT @limit OFFSET @offset
      `).all({ q: `${options.q.replaceAll('"', "")}*`, limit, offset }).map((row) => rowToTrack(row as TrackRow));
    }

    const favoriteClause = options.favorite ? "WHERE favorite = 1" : "";
    return db.prepare(`
      SELECT * FROM tracks
      ${favoriteClause}
      ORDER BY album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE
      LIMIT @limit OFFSET @offset
    `).all({ limit, offset }).map((row) => rowToTrack(row as TrackRow));
  }

  function listAlbums(limit = 200): Album[] {
    return db.prepare(`
      SELECT
        lower(COALESCE(album, '未知专辑')) || '::' || lower(COALESCE(album_artist, artist, '未知艺人')) AS album_key,
        COALESCE(album, '未知专辑') AS album,
        COALESCE(album_artist, artist) AS album_artist,
        MIN(artist) AS artist,
        MIN(year) AS year,
        COUNT(*) AS track_count,
        COALESCE(SUM(duration), 0) AS duration,
        MIN(CASE WHEN artwork_path IS NOT NULL THEN id END) AS artwork_track_id
      FROM tracks
      GROUP BY album_key
      ORDER BY MAX(added_at) DESC
      LIMIT ?
    `).all(limit).map((row) => rowToAlbum(row as TrackRow));
  }

  function listArtists(limit = 200): Artist[] {
    return db.prepare(`
      SELECT
        COALESCE(album_artist, artist, '未知艺人') AS artist_name,
        COUNT(DISTINCT lower(COALESCE(album, '未知专辑'))) AS album_count,
        COUNT(*) AS track_count,
        COALESCE(SUM(duration), 0) AS duration,
        MIN(CASE WHEN artwork_path IS NOT NULL THEN id END) AS artwork_track_id
      FROM tracks
      GROUP BY artist_name
      ORDER BY artist_name COLLATE NOCASE
      LIMIT ?
    `).all(limit).map((row) => rowToArtist(row as TrackRow));
  }

  function playlistSelect(where = "", params: unknown[] = []): Playlist[] {
    return db.prepare(`
      SELECT p.*,
        COUNT(pt.track_id) AS track_count,
        COALESCE(SUM(t.duration), 0) AS duration
      FROM playlists p
      LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
      LEFT JOIN tracks t ON t.id = pt.track_id
      ${where}
      GROUP BY p.id
      ORDER BY p.updated_at DESC
    `).all(...params).map((row) => rowToPlaylist(row as TrackRow));
  }

  return {
    db,
    getTrack(id) {
      const row = db.prepare("SELECT * FROM tracks WHERE id = ?").get(id) as TrackRow | undefined;
      return row ? rowToTrack(row) : null;
    },
    listTracks,
    upsertTrack(track) {
      txUpsert(track);
    },
    removeMissingTracks(seenPaths) {
      const rows = db.prepare("SELECT id, path FROM tracks").all() as { id: string; path: string }[];
      const missing = rows.filter((row) => !seenPaths.has(row.path));
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
    getAlbum(key) {
      const album = listAlbums(10000).find((item) => item.key === key);
      if (!album) return null;
      const rows = db.prepare(`
        SELECT * FROM tracks
        WHERE lower(COALESCE(album, '未知专辑')) || '::' || lower(COALESCE(album_artist, artist, '未知艺人')) = ?
        ORDER BY disc_no, track_no, title COLLATE NOCASE
      `).all(key).map((row) => rowToTrack(row as TrackRow));
      return { album, tracks: rows };
    },
    listArtists,
    getArtist(name) {
      const artists = listArtists(10000);
      const artist = artists.find((item) => item.name === name);
      if (!artist) return null;
      const albums = listAlbums(10000).filter((item) => item.artist === name);
      const tracks = db.prepare(`
        SELECT * FROM tracks
        WHERE COALESCE(album_artist, artist, '未知艺人') = ?
        ORDER BY album COLLATE NOCASE, disc_no, track_no
      `).all(name).map((row) => rowToTrack(row as TrackRow));
      return { artist, albums, tracks };
    },
    search(q) {
      const tracks = listTracks({ q, limit: 25 });
      const qLower = q.toLowerCase();
      const albums = listAlbums(200).filter((album) =>
        album.title.toLowerCase().includes(qLower) || (album.artist ?? "").toLowerCase().includes(qLower)
      ).slice(0, 12);
      const artists = listArtists(200).filter((artist) => artist.name.toLowerCase().includes(qLower)).slice(0, 12);
      return { tracks, albums, artists };
    },
    toggleFavorite(id, favorite) {
      db.prepare("UPDATE tracks SET favorite = ?, updated_at = ? WHERE id = ?").run(favorite ? 1 : 0, now(), id);
      return this.getTrack(id);
    },
    createPlaylist(name, description = null) {
      const id = randomUUID();
      const timestamp = now();
      db.prepare("INSERT INTO playlists (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, name, description, timestamp, timestamp);
      return playlistSelect("WHERE p.id = ?", [id])[0];
    },
    listPlaylists() {
      return playlistSelect();
    },
    getPlaylist(id) {
      const playlist = playlistSelect("WHERE p.id = ?", [id])[0];
      if (!playlist) return null;
      const tracks = db.prepare(`
        SELECT t.* FROM playlist_tracks pt
        JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = ?
        ORDER BY pt.position
      `).all(id).map((row) => rowToTrack(row as TrackRow));
      return { playlist, tracks };
    },
    addTrackToPlaylist(playlistId, trackId) {
      const maxPosition = db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM playlist_tracks WHERE playlist_id = ?")
        .get(playlistId) as { next: number };
      db.prepare("INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)")
        .run(playlistId, trackId, maxPosition.next, now());
      db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now(), playlistId);
    },
    removeTrackFromPlaylist(playlistId, trackId) {
      db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?").run(playlistId, trackId);
      db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now(), playlistId);
    },
    createScanJob() {
      const job: ScanJob = {
        id: randomUUID(),
        status: "running",
        startedAt: now(),
        finishedAt: null,
        totalFiles: 0,
        scannedFiles: 0,
        errorCount: 0,
        message: null
      };
      db.prepare(`
        INSERT INTO scan_jobs (id, status, started_at, total_files, scanned_files, error_count, message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(job.id, job.status, job.startedAt, 0, 0, 0, null);
      return job;
    },
    updateScanJob(id, patch) {
      const current = this.latestScan();
      if (!current || current.id !== id) return;
      const next = { ...current, ...patch };
      db.prepare(`
        UPDATE scan_jobs
        SET status = ?, started_at = ?, finished_at = ?, total_files = ?, scanned_files = ?, error_count = ?, message = ?
        WHERE id = ?
      `).run(next.status, next.startedAt, next.finishedAt, next.totalFiles, next.scannedFiles, next.errorCount, next.message, id);
    },
    latestScan() {
      return rowToScan(db.prepare("SELECT * FROM scan_jobs ORDER BY started_at DESC LIMIT 1").get() as TrackRow | undefined);
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
          COUNT(DISTINCT lower(COALESCE(album, '未知专辑')) || '::' || lower(COALESCE(album_artist, artist, '未知艺人'))) AS album_count,
          COUNT(DISTINCT COALESCE(album_artist, artist, '未知艺人')) AS artist_count,
          SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END) AS favorite_count,
          COALESCE(SUM(duration), 0) AS total_duration
        FROM tracks
      `).get() as TrackRow;
      const playlistCount = db.prepare("SELECT COUNT(*) AS count FROM playlists").get() as { count: number };
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

export function makeAlbumKey(album: string | null, albumArtist: string | null, artist: string | null): string {
  return albumKey(album, albumArtist, artist);
}
