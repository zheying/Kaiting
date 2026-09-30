import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Album as ApiAlbum, ScanJob, ScanError } from "../../shared/types.js";
import type { SessionResponse } from "../../shared/accounts.js";
import { api } from "../api.js";
import { errorMessage, loadAlbums, loadPlaylists, mapAlbum, mapPlaylist, mapTrack, mergePlaylistResults, type Track, type Playlist } from "./catalog-data.js";
export { mapPlaylist, type Album, type Track, type Playlist } from "./catalog-data.js";

export type CatalogResource = "tracks" | "albums" | "playlists";
export type RoomResource = CatalogResource | "summary" | "directory";
export type ResourceState = { status: "ready" | "loading" | "error"; error: string; hasValue: boolean };
const resourceNames: RoomResource[] = ["tracks", "albums", "playlists", "summary", "directory"];
const catalogNames: CatalogResource[] = ["tracks", "albums", "playlists"];
const initialResources = () => Object.fromEntries(resourceNames.map((key) => [key, { status: "loading", error: "", hasValue: false }])) as Record<RoomResource, ResourceState>;

export function useRoomData(session: SessionResponse) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [rawAlbums, setRawAlbums] = useState<ApiAlbum[]>([]);
  const albums = useMemo(() => rawAlbums.map((album) => mapAlbum(album, tracks)), [rawAlbums, tracks]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [directory, setDirectory] = useState(session.directory);
  const [scanJob, setScanJob] = useState<ScanJob | null>(null);
  const [scanErrors, setScanErrors] = useState<ScanError[]>([]);
  const [scanError, setScanError] = useState("");
  const [resources, setResources] = useState(initialResources);
  const requests = useRef(new Map<string, AbortController>());
  const alive = useRef(true);
  const catalogRevision = useRef<string | null>(null);

  const run = useCallback(async <T,>(key: RoomResource, read: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void): Promise<boolean> => {
    requests.current.get(key)?.abort();
    const controller = new AbortController();
    requests.current.set(key, controller);
    const active = () => alive.current && !controller.signal.aborted && requests.current.get(key) === controller;
    setResources((previous) => ({ ...previous, [key]: { ...previous[key], status: "loading", error: "" } }));
    try {
      const value = await read(controller.signal);
      if (!active()) return false;
      apply(value);
      setResources((previous) => ({ ...previous, [key]: { status: "ready", error: "", hasValue: true } }));
      return true;
    } catch (reason) {
      if (active()) setResources((previous) => ({ ...previous, [key]: { ...previous[key], status: "error", error: errorMessage(reason) } }));
      return false;
    } finally {
      if (requests.current.get(key) === controller) requests.current.delete(key);
    }
  }, []);

  const refresh = useCallback(async (resource?: RoomResource) => {
    const loaders: Record<RoomResource, () => Promise<boolean>> = {
      tracks: () => run("tracks", (signal) => api.allTracks({}, signal), (items) => setTracks(items.map(mapTrack))),
      albums: () => run("albums", loadAlbums, setRawAlbums),
      playlists: () => {
        for (const [key, request] of requests.current) if (key.startsWith("playlist:")) request.abort();
        return run("playlists", loadPlaylists, (items) => setPlaylists((previous) => mergePlaylistResults(previous, items)));
      },
      summary: () => run("summary", api.summary, (summary) => { setScanJob(summary.latestScan); setScanError(""); }),
      directory: () => run("directory", api.me, (me) => setDirectory(me.directory))
    };
    const keys = resource ? [resource] : resourceNames;
    const results = await Promise.all(keys.map((key) => loaders[key]()));
    if (alive.current && results.every((success) => !success)) throw new Error("连接暂时中断，请稍后重试。");
  }, [run]);

  const refreshPlaylist = useCallback(async (id: string) => {
    const key = `playlist:${id}`;
    requests.current.get(key)?.abort();
    const controller = new AbortController(); requests.current.set(key, controller);
    const active = () => alive.current && !controller.signal.aborted && requests.current.get(key) === controller;
    setPlaylists((items) => items.map((item) => item.id === id ? { ...item, detailLoading: true } : item));
    try {
      const detail = mapPlaylist(await api.playlist(id, controller.signal));
      if (active()) setPlaylists((items) => items.map((item) => item.id === id ? detail : item));
    } catch (reason) {
      if (active()) setPlaylists((items) => items.map((item) => item.id === id ? { ...item, detailLoading: false, detailError: errorMessage(reason) } : item));
    } finally {
      if (requests.current.get(key) === controller) requests.current.delete(key);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    // Capture the version before loading, so enrichment completing during the load is not missed.
    void (async () => {
      try { const value = await api.catalogStatus(controller.signal); if (!controller.signal.aborted) catalogRevision.current = value.revision; } catch { /* Catalog loading still works if the status endpoint is temporarily unavailable. */ }
      if (!controller.signal.aborted) await refresh().catch(() => undefined);
    })();
    return () => { controller.abort(); alive.current = false; for (const request of requests.current.values()) request.abort(); };
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 15_000;
      try {
        if (document.visibilityState === "hidden") return;
        const value = await api.catalogStatus(controller.signal);
        if (controller.signal.aborted) return;
        if (value.enrichment.state === "running" || value.scanRunning) delay = 3000;
        if (!value.scanRunning && value.revision !== catalogRevision.current) {
          // Existing content stays visible; refreshing metadata does not recreate the player.
          await Promise.all([refresh("tracks"), refresh("albums"), refresh("summary")]);
          if (!controller.signal.aborted) catalogRevision.current = value.revision;
        }
      } catch { /* A later poll retries without interrupting music or replacing the page. */ }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, delay); }
    };
    timer = setTimeout(poll, 3000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);
  const lastComplete = useRef<string | null>(null);
  useEffect(() => {
    if (!scanJob || scanJob.status !== "running") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.scanStatus();
        if (cancelled) return;
        setScanError(""); setScanJob(next);
        if (next && next.status !== "running" && next.id !== lastComplete.current) { lastComplete.current = next.id; await refresh(); }
      } catch (reason) { if (!cancelled) setScanError(errorMessage(reason)); }
      if (!cancelled) timer = setTimeout(poll, 1200);
    };
    timer = setTimeout(poll, 800);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [scanJob?.id, scanJob?.status, refresh]);
  useEffect(() => {
    if (!scanJob || scanJob.status === "running") return;
    const controller = new AbortController();
    void api.scanErrors(controller.signal).then((errors) => { if (!controller.signal.aborted) setScanErrors(errors); }).catch(() => undefined);
    return () => controller.abort();
  }, [scanJob?.id, scanJob?.status]);
  function clearDirectoryContent() {
    for (const request of requests.current.values()) request.abort();
    setTracks([]); setRawAlbums([]); setScanErrors([]); setScanError("");
    setResources(initialResources());
    setPlaylists((items) => items.map((item) => ({ ...item, trackIds: [], detailError: undefined, detailLoading: false })));
  }
  // Only a total outage gets the global error page. Individual failures keep their data and retry locally.
  const status = catalogNames.every((key) => resources[key].status === "error" && !resources[key].hasValue) ? "error"
    : catalogNames.every((key) => resources[key].status === "loading" && !resources[key].hasValue) ? "loading" : "ready";
  const updateAlbum = (album: ApiAlbum) => setRawAlbums((items) => items.map((item) => item.key === album.key ? album : item));
  return { tracks, albums, playlists, setPlaylists, setTracks, updateAlbum, directory, setDirectory, scanJob, setScanJob, scanErrors, scanError, resources, status, refresh, refreshPlaylist, clearDirectoryContent };
}
