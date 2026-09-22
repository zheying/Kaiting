import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Album, Artist, LibrarySummary, Page, PageOptions, Playlist, PlaylistDetail, ScanError, ScanJob, ScanOptions, Track, TrackPageOptions } from "../shared/types.js";

type TrackRow = Record<string, unknown>;
type PlaylistOrderResult = { status: "ok"; detail: PlaylistDetail } | { status: "not_found" } | { status: "conflict" };

export interface DatabaseHandle {
  db: Database.Database;
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
    album: row.album ? String(row.album) : null,
    albumKey: albumKey(row.album, row.album_artist, row.artist, row.path),
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

function albumKey(album: unknown, albumArtist: unknown, artist: unknown, filePath?: unknown): string {
  // Keep keys identical to SQLite lower(), including non-ASCII album/artist names.
  const lowerAscii = (value: unknown) => String(value).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (albumArtist == null && filePath != null) {
    // Missing album-artist tags are common in soundtracks. A shared title alone
    // cannot identify a release: only combine tracks in the exact same directory.
    // Do not collapse disc folders or strip edition suffixes without explicit tags.
    // dirname only reads the indexed string; it never accesses the music files.
    const identity = [path.dirname(String(filePath)), lowerAscii(album ?? "未知专辑"), album == null ? lowerAscii(artist ?? "未知艺人") : null];
    return `folder:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  }
  // Preserve explicit album-artist identities, including multi-disc releases
  // spanning CD1/CD2 directories and links saved by earlier app versions.
  return `${lowerAscii(album ?? "未知专辑")}::${lowerAscii(albumArtist ?? artist ?? "未知艺人")}`;
}

export function openDatabase(databasePath: string): DatabaseHandle {
  const db = new Database(databasePath);
  const instanceId = randomUUID();
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // SQLite lower() only folds ASCII; preserve ordinary Unicode substring search.
  db.function("search_lower", { deterministic: true }, (value) => String(value ?? "").toLowerCase());
  db.function("release_album_key", { deterministic: true }, (album, albumArtist, artist, filePath) => albumKey(album, albumArtist, artist, filePath));

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

  // Additive migration preserves scan history from versions before incremental scans.
  const scanColumns = new Set((db.pragma("table_info(scan_jobs)") as { name: string }[]).map((column) => column.name));
  for (const column of ["parsed_files", "skipped_files", "force", "prune"]) {
    if (!scanColumns.has(column)) db.exec(`ALTER TABLE scan_jobs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }

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

  function trackQuery(options: TrackPageOptions) {
    const favoriteClause = options.favorite ? "tracks.favorite = 1" : "1 = 1";
    if (options.q?.trim()) {
      // Treat input as ordinary words, never as FTS operators or column names.
      const terms = options.q.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
      if (terms.length === 0) return { from: "tracks", where: "0 = 1", order: "tracks.id", params: {} };
      const query = terms.map((term) => `"${term}"*`).join(" AND ");
      return {
        from: "tracks_fts JOIN tracks ON tracks.rowid = tracks_fts.rowid",
        where: `tracks_fts MATCH @q AND ${favoriteClause}`,
        order: "rank, tracks.id",
        params: { q: query }
      };
    }
    return {
      from: "tracks",
      where: favoriteClause,
      order: "album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE, tracks.id",
      params: {}
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
    `).all({ ...query.params, limit, offset }).map((row) => rowToTrack(row as TrackRow));
  }

  function pageRevision(): string {
    // Called after the first SELECT and before the page's read transaction ends.
    // Local writes, external commits, and reopened connections must invalidate a
    // multi-page queue even when the number of matching tracks has not changed.
    const changes = db.prepare("SELECT total_changes() AS changes").get() as { changes: number };
    const dataVersion = db.pragma("data_version", { simple: true });
    return `${instanceId}:${changes.changes}:${dataVersion}`;
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
        MIN(COALESCE(album, '未知专辑')) AS album,
        CASE WHEN COUNT(DISTINCT lower(COALESCE(album_artist, artist))) > 1 THEN '多位艺人'
          ELSE MIN(COALESCE(album_artist, artist)) END AS album_artist,
        MIN(artist) AS artist,
        MIN(year) AS year,
        COUNT(*) AS track_count,
        COALESCE(SUM(duration), 0) AS duration,
        MIN(CASE WHEN artwork_path IS NOT NULL THEN id END) AS artwork_track_id,
        MAX(added_at) AS newest_added_at
      FROM tracks
      GROUP BY album_key
  `;
  const albumFilter = `(@q = '' OR instr(search_lower(album), @q) > 0 OR instr(search_lower(album_artist), @q) > 0 OR album_key IN (
    SELECT release_album_key(album, album_artist, artist, path) FROM tracks
    WHERE instr(search_lower(album_artist), @q) > 0 OR instr(search_lower(artist), @q) > 0
  ))`;

  const artistSelect = `
      SELECT
        COALESCE(album_artist, artist, '未知艺人') AS artist_name,
        COUNT(DISTINCT release_album_key(album, album_artist, artist, path)) AS album_count,
        COUNT(*) AS track_count,
        COALESCE(SUM(duration), 0) AS duration,
        MIN(CASE WHEN artwork_path IS NOT NULL THEN id END) AS artwork_track_id
      FROM tracks
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
    if (!row && key.includes("::")) {
      // An old per-performer URL can now resolve to a complete directory album.
      // If it names more than one release, do not silently select or merge them.
      const matches = db.prepare(`
        SELECT DISTINCT release_album_key(album, album_artist, artist, path) AS album_key FROM tracks
        WHERE lower(COALESCE(album, '未知专辑')) || '::' || lower(COALESCE(album_artist, artist, '未知艺人')) = ?
        LIMIT 2
      `).all(key) as { album_key: string }[];
      if (matches.length !== 1) return null;
      key = matches[0].album_key;
      row = db.prepare(`SELECT * FROM (${albumSelect}) WHERE album_key = ?`).get(key) as TrackRow | undefined;
    }
    if (!row) return null;
    const tracks = db.prepare(`
      SELECT * FROM tracks WHERE release_album_key(album, album_artist, artist, path) = ?
      ORDER BY disc_no, track_no, title COLLATE NOCASE, id
    `).all(key).map((track) => rowToTrack(track as TrackRow));
    return { album: rowToAlbum(row), tracks };
  });

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
      ORDER BY p.updated_at DESC, p.id
    `).all(...params).map((row) => rowToPlaylist(row as TrackRow));
  }

  const getPlaylist = db.transaction((id: string): PlaylistDetail | null => {
    const playlist = playlistSelect("WHERE p.id = ?", [id])[0];
    if (!playlist) return null;
    const tracks = db.prepare(`
      SELECT t.* FROM playlist_tracks pt
      JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position, pt.track_id
    `).all(id).map((row) => rowToTrack(row as TrackRow));
    const revision = createHash("sha256")
      .update(JSON.stringify([id, playlist.name, playlist.description, tracks.map((track) => track.id)]))
      .digest("hex");
    return { playlist, tracks, revision };
  });

  function writePlaylistOrder(playlistId: string, trackIds: string[]): void {
    const update = db.prepare("UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?");
    trackIds.forEach((trackId, index) => update.run(index + 1, playlistId, trackId));
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
    if (!current || !db.prepare("SELECT id FROM tracks WHERE id = ?").get(trackId)) return null;
    if (current.tracks.some((track) => track.id === trackId)) return current;
    // Compact legacy gaps before appending, so every successful mutation keeps positions contiguous.
    writePlaylistOrder(playlistId, current.tracks.map((track) => track.id));
    db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)")
      .run(playlistId, trackId, current.tracks.length + 1, now());
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
    getIndexedTrack(filePath) {
      const row = db.prepare("SELECT * FROM tracks WHERE path = ?").get(filePath) as TrackRow | undefined;
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
      return (db.prepare("SELECT path FROM tracks ORDER BY path").all() as { path: string }[]).map((row) => row.path);
    },
    getTrack(id) {
      const row = db.prepare("SELECT * FROM tracks WHERE id = ?").get(id) as TrackRow | undefined;
      return row ? rowToTrack(row) : null;
    },
    getTrackLyricsPath(id) {
      const row = db.prepare("SELECT lyrics_path FROM tracks WHERE id = ?").get(id) as { lyrics_path?: string | null } | undefined;
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
      const rows = db.prepare("SELECT id, path FROM tracks").all() as { id: string; path: string }[];
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
          FROM tracks WHERE COALESCE(album_artist, artist, '未知艺人') = ?
        )
        ORDER BY newest_added_at DESC, album_key
      `).all(name).map((album) => rowToAlbum(album as TrackRow));
      const tracks = db.prepare(`
        SELECT * FROM tracks
        WHERE COALESCE(album_artist, artist, '未知艺人') = ?
        ORDER BY album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE, id
      `).all(name).map((row) => rowToTrack(row as TrackRow));
      return { artist, albums, tracks };
    },
    search(q) {
      const tracks = listTracks({ q, limit: 25 });
      const albums = pageAlbums({ q, limit: 12 }).items;
      const artists = pageArtists({ q, limit: 12 }).items;
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
    getPlaylist,
    renamePlaylist: renamePlaylist.immediate,
    deletePlaylist(id) {
      return db.prepare("DELETE FROM playlists WHERE id = ?").run(id).changes > 0;
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
