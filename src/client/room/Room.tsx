function decodeRouteId(value: string) { try { return decodeURIComponent(value); } catch { return ""; } }
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, ChevronLeft,
  ChevronRight, Clock3, Disc3, FolderOpen, Headphones, Heart, House, Info, Library,
  ListMusic, LoaderCircle, MoreHorizontal, Music2, Pause, Play, Plus,
  RefreshCw, Search, Settings2, Shuffle, SkipForward, UserRound, Pencil, Trash2,
  X, type LucideIcon
} from "lucide-react";
import { api, ApiError, artworkUrl } from "../api.js";
import { createRequestId } from "../request-id.js";
import type { SessionResponse } from "../../shared/accounts.js";
import type { ScanJob } from "../../shared/types.js";
import { useRoomData, mapPlaylist, type Album, type Track, type Playlist, type RoomResource } from "./data.js";
import { buildAlbumMap, buildArtistIndex, errorMessage } from "./catalog-data.js";
import { useRoomPlayer } from "./player.js";
import { CapsulePlayer } from "./CapsulePlayer.js";
import { NowPlaying } from "./NowPlaying.js";
import { AlbumMetadataForm } from "./AlbumMetadataForm.js";
import { PlaylistOrderEditor } from "./PlaylistOrderEditor.js";
import { AccountAvatar, AccountPages } from "./AccountPages.js";
import { roleLabel, type AccountSession, type AccountUser } from "./account-state.js";
import { Artwork, ContentSkeleton, PlaybackFeedback } from "./StateComponents.js";
import { scanCompletionNotice, scanState, yearLabel, trackTime } from "./room-state.js";
import { useMobileLayout } from "../mobile-layout.js";

type ModalState = { type: "album-metadata"; albumId: string } | { type: "create"; trackId?: string } | { type: "add"; trackId: string } | { type: "playlist-add"; playlistId: string } | { type: "info" } | { type: "settings" } | { type: "directory"; returnTo?: "settings" | "directory-unavailable" } | { type: "scan-failures" } | { type: "rename" | "delete"; playlistId: string } | null;
type StateAction = { label: string; onClick: () => void; variant?: "primary" | "subtle"; disabled?: boolean; busy?: boolean };
type CheckKind = "service" | "directory" | "partial";
type CheckStatus = "idle" | "checking" | "failed" | "complete";
const LibraryContext = createContext<{ albumMap: Map<string, Album>; trackMap: Map<string, Track> }>({ albumMap: new Map(), trackMap: new Map() });
const displayTitle = (track: Track) => track.title.split(" ／ ")[0].replace(/ \(FF7 Rebirth OST Ver\.\)/g, "");
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const durationLabel = (seconds: number) => seconds >= 3600 ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟` : `${Math.ceil(seconds / 60)} 分钟`;
const emptyAlbum: Album = { id: "", name: "未命名专辑", title: "未命名专辑", artist: "未知艺人", year: 0, genre: "未分类", cover: "", duration: 0, trackCount: 0, lossless: false };
const navItems: { route: string; title: string; icon: LucideIcon }[] = [
  { route: "home", title: "现在就听", icon: House },
  { route: "albums", title: "专辑", icon: Disc3 },
  { route: "songs", title: "歌曲", icon: Music2 },
  { route: "artists", title: "艺人", icon: UserRound },
  { route: "favorites", title: "我的收藏", icon: Heart }
];
const readRoute = () => window.location.hash.replace(/^#\/?/, "") || "home";
const readSearchQuery = () => {
  const rawRoute = window.location.hash.replace(/^#\/?/, "");
  const [path, search] = rawRoute.split("?");
  if (path.startsWith("search/")) return decodeRouteId(path.slice("search/".length));
  return path === "search" && search ? new URLSearchParams(search).get("q") ?? "" : "";
};

function IconButton({ label, children, onClick, active = false, className = "", disabled = false }: {
  label: string; children: ReactNode; onClick: () => void; active?: boolean; className?: string; disabled?: boolean;
}) {
  return <button type="button" className={`icon-button ${active ? "is-active" : ""} ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

function BrandGlyph() {
  return <svg className="brand-glyph" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <circle cx="16" cy="16" r="11.2" stroke="currentColor" strokeWidth="1.5" opacity=".72" />
    <path d="M8 16c1.3-4 2.7-4 4 0s2.7 4 4 0 2.7-4 4 0 2.7 4 4 0" stroke="var(--brand-accent, #e2556d)" strokeWidth="2.05" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="16" cy="16" r="1.85" fill="var(--brand-core, #111719)" stroke="currentColor" strokeWidth="1.05" />
  </svg>;
}


function Modal({ children, className = "", label, onClose }: { children: ReactNode; className?: string; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      const target = dialog?.querySelector<HTMLElement>("input, [autofocus]") ?? dialog?.querySelector<HTMLElement>("[aria-label^='关闭']");
      target?.focus();
    });
    return () => { window.cancelAnimationFrame(frame); dialog?.close(); document.body.style.overflow = originalOverflow; previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={className} aria-label={label} onCancel={(event) => { event.preventDefault(); closeRef.current(); }} onClick={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>{children}</dialog>;
}

function Cover({ album, className = "", lazy = true }: { album: Album; className?: string; lazy?: boolean }) {
  return <Artwork className={`cover ${className}`} src={album.cover} alt={`${album.name} 专辑封面`} lazy={lazy} />;
}

function PlaylistArt({ playlist }: { playlist: Pick<Playlist, "id" | "name" | "description" | "trackIds" | "detailError"> }) {
  const { albumMap, trackMap } = useContext(LibraryContext);
  const covers = [...new Set(playlist.trackIds.map((id) => trackMap.get(id)?.albumId))]
    .map((id) => id ? albumMap.get(id) : undefined)
    .filter((album): album is Album => Boolean(album))
    .slice(0, 4);
  return <div className="playlist-art" data-cover-count={covers.length} role="img" aria-label={`${playlist.name}的歌单封面${covers.length ? "" : playlist.detailError ? "，封面暂未载入" : "，暂无歌曲"}`}>
    {covers.length ? covers.map((album) => <Cover key={album.id} album={album} />) : <ListMusic aria-hidden="true" />}
  </div>;
}

function StatePanel({ icon: Icon, eyebrow, title, description, actions = [], tone = "", className = "", busy = false }: {
  icon: LucideIcon;
  eyebrow?: string;
  title: string;
  description: string;
  actions?: StateAction[];
  tone?: "error" | "";
  className?: string;
  busy?: boolean;
}) {
  return <section className={`state-panel ${tone ? `is-${tone}` : ""} ${className}`.trim()} role={tone === "error" ? "alert" : "region"} aria-label={title} aria-busy={busy}>
    <span className="state-icon"><Icon aria-hidden="true" /></span>
    {eyebrow && <span className="eyebrow">{eyebrow}</span>}
    <h2>{title}</h2>
    <p>{description}</p>
    {actions.length > 0 && <div className="state-actions">{actions.map((action) => <button type="button" className={`button ${action.variant === "subtle" ? "subtle" : "primary"}`} key={action.label} onClick={action.onClick} disabled={action.disabled}>{action.busy && <LoaderCircle className="button-spinner" aria-hidden="true" />}{action.label}</button>)}</div>}
  </section>;
}

export function Room({ session, onUserChange, onLogout }: { session: SessionResponse; onUserChange: (user: AccountUser) => void; onLogout: (reason?: string) => void | Promise<void> }) {
  const data = useRoomData(session);
  const { tracks, albums, playlists, setPlaylists } = data;
  const albumMap = useMemo(() => buildAlbumMap(albums, tracks), [albums, tracks]);
  const artistIndex = useMemo(() => buildArtistIndex(albums, tracks), [albums, tracks]);
  const trackMap = new Map(tracks.map((track) => [track.id, track]));
  const albumTracks = (id: string) => tracks.filter((track) => track.albumId === id).sort((a, b) => a.disc - b.disc || (a.trackNo ?? 9999) - (b.trackNo ?? 9999) || a.fileName.localeCompare(b.fileName));
  const featured = albums[0];
  const favorites = new Set(tracks.filter((track) => track.favorite).map((track) => track.id));
  const player = useRoomPlayer(tracks, session.preferences, data.resources.tracks.hasValue);
  const { queue, setQueue, currentId, isPlaying, position, volume, setVolume, shuffle, setShuffle, repeat, setRepeat, phase, play, togglePlay, nextTrack, previousTrack } = player;

  const isMobile = useMobileLayout();
  const [route, setRoute] = useState(readRoute);
  const backgroundRoute = useRef("home");
  const previousPage = useRef(route === "playing" ? "home" : route);
  const [query, setQuery] = useState(readSearchQuery);
  const [searchCommitted, setSearchCommitted] = useState(() => Boolean(readSearchQuery()));
  const [searchFocused, setSearchFocused] = useState(false);
  const [albumDiscFilter, setAlbumDiscFilter] = useState("全部");
  const [formatFilter, setFormatFilter] = useState("全部");
  const [queueOpen, setQueueOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [playlistError, setPlaylistError] = useState("");
  const [playlistTrackQuery, setPlaylistTrackQuery] = useState("");
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null);
  const [toast, setToast] = useState("");
  const [pageLimit, setPageLimit] = useState(40);
  const [dense, setDense] = useState(session.preferences.dense);
  const [darkMode, setDarkMode] = useState(session.preferences.darkMode);
  const musicDirectory = data.directory.path;
  const directoryConfigured = data.directory.configured;
  const directoryOptions = data.directory.options;
  const scanFailures = data.scanErrors.map((error) => ({ path: error.path, reason: error.message, hint: "检查文件与目录访问权限后重试" }));
  const scanFailureCount = data.scanJob?.errorCount ?? scanFailures.length;
  const [directorySelection, setDirectorySelection] = useState(data.directory.path);
  const [directoryError, setDirectoryError] = useState("");
  const [scanStartError, setScanStartError] = useState<{ path: string; message: string } | null>(null);
  const [scanStarting, setScanStarting] = useState(false);
  const startingScan = useRef(false);
  const [checkStatus, setCheckStatus] = useState<Record<CheckKind, CheckStatus>>({ service: "idle", directory: "idle", partial: "idle" });
  const retryTimer = useRef<number | null>(null);
  const [contentScrollbarWidth, setContentScrollbarWidth] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const libraryMode = !directoryConfigured ? "unconfigured" : tracks.length ? "ready" : "empty";
  const authenticated = true;
  const accountUser = session.user;
  const canManageLibrary = accountUser.role === "admin";
  const [accounts, setAccounts] = useState<AccountUser[]>([session.user]);
  const [accountSessions, setAccountSessions] = useState<AccountSession[]>([]);
  const [accountLoadState, setAccountLoadState] = useState<"ready" | "loading" | "error">("loading");
  const loginReturn = useRef("home");
  const scan = scanStartError ? { ...scanState(null, scanStartError.path, tracks.length), status: "failed" as const, message: scanStartError.message } : scanState(data.scanJob, musicDirectory, tracks.length);
  const previousScan = useRef<ScanJob | null | undefined>(undefined);
  const [writeState, setWriteState] = useState<"idle" | "saving" | "error">("idle");
  const [writeLabel, setWriteLabel] = useState("");
  const [writeError, setWriteError] = useState("");
  const savingWrite = useRef(false);
  const pendingWrite = useRef<(() => Promise<void>) | null>(null);
  const writeTimer = useRef<number | null>(null);
  const [orderDraft, setOrderDraft] = useState<string[] | null>(null);
  const [moreState, setMoreState] = useState<"ready" | "loading" | "error">("ready");
  const requestTimer = useRef<number | null>(null);
  const hasCurrent = Boolean(currentId);
  const current = player.current ?? ({ id: "", title: "", artist: "", duration: 0, albumId: "", format: "" } as Track);
  const currentAlbum = albumMap.get(current.albumId) ?? { ...emptyAlbum, id: current.albumId, name: current.album ?? "未命名专辑", title: current.album ?? "未命名专辑", cover: current.hasArtwork ? artworkUrl(current.id) ?? "" : "" };
  const currentIndex = queue.findIndex((track) => track.id === currentId);
  const pageRoute = route === "playing" ? backgroundRoute.current : route;
  const browseRoute = useRef(pageRoute);
  const [section, routeId] = pageRoute.split("?")[0].split("/");
  const [missingAlbumKey, setMissingAlbumKey] = useState("");
  const [albumLookupError, setAlbumLookupError] = useState("");
  const [albumLookupAttempt, setAlbumLookupAttempt] = useState(0);
  useEffect(() => {
    const key = decodeRouteId(routeId);
    if (section !== "album" || data.resources.albums.status !== "ready" || albums.some((album) => album.id === key)) return;
    const controller = new AbortController();
    // Older bookmarks may refer to a single disc that now belongs to a merged release.
    setMissingAlbumKey(""); setAlbumLookupError("");
    void api.album(key, controller.signal).then(({ album }) => {
      if (controller.signal.aborted) return;
      if (album.key !== key) window.location.replace(`#/album/${encodeURIComponent(album.key)}`);
      else setMissingAlbumKey(key);
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 404) setMissingAlbumKey(key);
      else setAlbumLookupError(errorMessage(reason));
    });
    return () => controller.abort();
  }, [section, routeId, data.resources.albums.status, albums, albumLookupAttempt]);
  useEffect(() => setDirectoryError(""), [modal?.type]);
  const searching = searchCommitted && query.trim().length > 0;
  const searchSuggestionsOpen = searchFocused && !searching && query.trim().length > 0;
  const loginRoute = false;
  const homePage = !searching && (section === "home" || (section === "preview" && ["home-new", "player-empty"].includes(routeId)));
  const catalogPage = !homePage && (searching || ["search", "albums", "album", "songs", "favorites", "playlists", "playlist", "artist", "loading", "error", "preview", "scan", "setup", "directory-unavailable", "account", "admin"].includes(section));
  const libraryDirectoryNeedsScan = libraryMode === "empty" && scan.status === "idle";
  const initialSetup = !directoryConfigured;
  const directoryUnavailable = directoryConfigured && !data.directory.available;
  const partialScan = scan.status === "partial";

  function announce(message: string) { setToast(""); window.setTimeout(() => setToast(message), 0); }
  useEffect(() => {
    // Wait for the refreshed library so a first scan is not mistaken for an empty result.
    if (data.resources.tracks.status !== "ready" || data.resources.summary.status !== "ready") return;
    const message = scanCompletionNotice(previousScan.current, data.scanJob, tracks.length);
    previousScan.current = data.scanJob;
    if (canManageLibrary && message) announce(message);
  }, [data.resources.tracks.status, data.resources.summary.status, data.scanJob, tracks.length, canManageLibrary]);
  async function refreshAccounts() {
    setAccountLoadState("loading");
    try {
      const [users, sessions] = await Promise.all([canManageLibrary ? api.users() : Promise.resolve([session.user]), api.sessions()]);
      setAccounts(users); setAccountSessions(sessions); setAccountLoadState("ready");
    } catch (reason) { setAccountLoadState("error"); throw reason; }
  }
  useEffect(() => { void refreshAccounts().catch(() => undefined); }, [accountUser.id, accountUser.role]);
  function updateAccount(next: AccountUser) {
    setAccounts((previous) => previous.map((item) => item.id === next.id ? next : item));
    if (next.id === accountUser.id) onUserChange(next);
  }
  function signOut(reason = "signed-out") { return onLogout(reason); }
  function renderAccount(view: "profile" | "security" | "users" | "denied" = "profile") {
    return <AccountPages user={accountUser} users={accounts} sessions={accountSessions} view={view} accountLoadState={accountLoadState} onReload={refreshAccounts} favoriteCount={favorites.size} playlistCount={playlists.length}
      onUserChange={updateAccount} onCreate={(created) => setAccounts((previous) => [...previous, created])}
      onRevoke={(ids) => setAccountSessions((previous) => previous.filter((item) => !ids.includes(item.id)))}
      onNavigate={navigate} onLogin={() => navigate("login")} onLogout={signOut} onDirectory={() => setModal({ type: "settings" })} onNotice={announce} />;
  }
  async function retryLibrary(kind: CheckKind) {
    if (!canManageLibrary && kind !== "service") { navigate("account/permissions"); return; }
    if (kind === "partial") { await startDirectoryScan(musicDirectory); return; }
    setCheckStatus((previous) => ({ ...previous, [kind]: "checking" }));
    try {
      if (kind === "directory") { const directory = await api.directories(); data.setDirectory(directory); if (!directory.available) throw new Error("音乐目录仍不可访问，请检查 NAS 挂载和目录权限。"); if (!await startDirectoryScan(musicDirectory)) { setCheckStatus((previous) => ({ ...previous, [kind]: "failed" })); return; } }
      else await data.refresh();
      setCheckStatus((previous) => ({ ...previous, [kind]: "complete" }));
    } catch (reason) { setCheckStatus((previous) => ({ ...previous, [kind]: "failed" })); announce(reason instanceof Error ? reason.message : "连接失败，请重试"); }
  }
  async function startDirectoryScan(path: string) {
    if (!canManageLibrary) { setModal(null); navigate("account/permissions"); return false; }
    if (startingScan.current) return false;
    startingScan.current = true; setScanStarting(true); setDirectoryError("");
    try {
      let job: ScanJob | null;
      if (!directoryConfigured || path !== musicDirectory) {
        const result = await api.selectDirectory(path);
        if (result.directory.path !== musicDirectory) { player.clear(); data.clearDirectoryContent(); }
        data.setDirectory(result.directory); job = result.scan;
      }
      else job = await api.scan();
      if (previousScan.current === undefined) previousScan.current = null;
      data.setScanJob(job);
      setScanStartError(null);
      // Small directories can finish before the start request returns, without a polling cycle.
      if (job && job.status !== "running") void data.refresh().catch(() => undefined);
      setModal(null); navigate("scan");
      return true;
    } catch (reason) {
      setScanStartError({ path, message: errorMessage(reason) });
      setModal(null); navigate("scan");
      return false;
    } finally { startingScan.current = false; setScanStarting(false); }
  }
  async function browseDirectory(path: string) {
    setDirectoryError("");
    try { data.setDirectory(await api.directories(path)); } catch (reason) { setDirectoryError(errorMessage(reason)); }
  }
  function cancelWrite() { if (writeState === "saving") return; pendingWrite.current = null; setWriteState("idle"); }
  async function finishWrite() {
    if (!pendingWrite.current || savingWrite.current) return;
    savingWrite.current = true;
    setWriteState("saving"); setWriteError("");
    try { await pendingWrite.current(); pendingWrite.current = null; setWriteState("idle"); announce("已保存"); }
    catch (reason) { setWriteState("error"); setWriteError(errorMessage(reason)); }
    finally { savingWrite.current = false; }
  }
  function saveChange(label: string, apply: () => Promise<void>) {
    if (savingWrite.current) return;
    if (pendingWrite.current) { announce("请先重试或取消上一次保存，再进行新的操作。"); return; }
    setWriteLabel(label); pendingWrite.current = apply; void finishWrite();
  }
  function closeDialog() { if (writeState === "saving" || scanStarting || metadataSaving) return; cancelWrite(); setModal(null); }
  function renderWriteFeedback(compact = false) {
    if (writeState === "idle") return null;
    const saving = writeState === "saving";
    const title = saving ? `正在${writeLabel}` : `${writeLabel}失败`;
    const detail = saving ? "稍等一下，即将完成。" : writeError || "连接暂时中断，原内容未改变，你的修改仍保留着。";
    const StatusIcon = saving ? LoaderCircle : AlertTriangle;
    const statusIcon = <StatusIcon className={saving ? "button-spinner" : undefined} aria-hidden="true" />;
    return <div className={`write-feedback ${writeState}${compact ? " is-compact" : ""}`} role={saving ? "status" : "alert"}>
      {compact ? <span className="feedback-status-icon" aria-hidden="true">{statusIcon}</span> : statusIcon}
      <div className="feedback-copy"><strong title={compact ? title : undefined}>{title}</strong><p title={compact ? detail : undefined}>{compact && !saving ? (isMobile ? "修改已保留，请重试" : "连接中断，修改已保留。") : detail}</p></div>
      {!saving && <div className="feedback-actions">
        <button type="button" className={compact ? "button feedback-retry" : undefined} onClick={finishWrite} aria-label="重试保存">{compact && <RefreshCw aria-hidden="true" />}{compact && isMobile ? "重试" : "重试保存"}</button>
        <button type="button" className={compact ? "button feedback-cancel" : undefined} onClick={cancelWrite} aria-label="取消保存" title="取消保存">{compact ? <X aria-hidden="true" /> : "取消"}</button>
      </div>}
    </div>;
  }
  function retryPlayback() { if (phase === "missing") { closePlayer(); navigate("directory-unavailable"); return; } player.retry(); }
  function loadMore() { setPageLimit((value) => value + 60); }
  function navigate(next: string) {
    if (requestTimer.current) window.clearTimeout(requestTimer.current);
    setMoreState("ready");
    setQuery(""); setSearchCommitted(false); setSearchFocused(false); setMenu(null); setPageLimit(40); setMobileNavOpen(false); setAlbumDiscFilter("全部"); setFormatFilter("全部");
    if (route !== "playing") backgroundRoute.current = route;
    window.location.hash = `/${next}`;
  }
  function clearSearch(focus = false) {
    setQuery(""); setSearchCommitted(false); setSearchFocused(focus);
    if (section === "search") window.location.hash = "/home";
    if (focus) window.setTimeout(() => searchRef.current?.focus(), 0);
  }
  function openPlayer() { if (!hasCurrent) return; backgroundRoute.current = pageRoute; setQueueOpen(false); window.location.hash = "/playing"; }
  function closePlayer() { if (section === "preview" && (routeId?.startsWith("lyrics-") || routeId === "queue-empty")) { navigate("preview"); return; } window.location.hash = `/${backgroundRoute.current === "playing" ? "home" : backgroundRoute.current}`; }
  function toggleFavorite(id: string) {
    const value = !favorites.has(id);
    saveChange("保存收藏", async () => { const next = await api.favorite(id, value); data.setTracks((items) => items.map((item) => item.id === id ? { ...item, favorite: next.favorite } : item)); });
  }
  function enqueue(track: Track, next = false) {
    if (track.id === currentId) { announce("这首歌曲正在播放"); setMenu(null); return; }
    if (!next && queue.some((item) => item.id === track.id)) { announce("这首歌已经在待播清单里了"); setMenu(null); return; }
    setQueue((items) => {
      const rest = items.filter((item) => item.id !== track.id);
      const index = rest.findIndex((item) => item.id === currentId);
      return next ? [...rest.slice(0, index + 1), track, ...rest.slice(index + 1)] : [...rest, track];
    });
    announce(next ? "已设为下一首播放" : "已加入待播清单"); setMenu(null);
  }
  function createPlaylist() {
    const name = newPlaylistName.trim();
    if (!name) { setPlaylistError("给歌单起一个名字吧"); return; }
    const trackId = modal && "trackId" in modal ? modal.trackId : undefined;
    let createdId = "";
    let requestId: string | undefined;
    saveChange("创建歌单", async () => {
      requestId ??= createRequestId();
      // Keep an acknowledged creation across retries of the optional initial track insertion.
      if (!createdId) createdId = (await api.createPlaylist(name, requestId)).id;
      const detail = trackId ? await api.addToPlaylist(createdId, trackId) : await api.playlist(createdId);
      const playlist = mapPlaylist(detail);
      setPlaylists((items) => [...items.filter((item) => item.id !== playlist.id), playlist]);
      setNewPlaylistName(""); setPlaylistError(""); setModal(null); navigate(`playlist/${playlist.id}`);
    });
  }
  function addToPlaylist(id: string, trackId: string) {
    if (playlists.find((item) => item.id === id)?.trackIds.includes(trackId)) { announce("这首歌已经在歌单里了"); return; }
    saveChange("添加歌曲", async () => { const detail = mapPlaylist(await api.addToPlaylist(id, trackId)); setPlaylists((items) => items.map((item) => item.id === id ? detail : item)); setModal(null); });
  }
  function removeFromPlaylist(id: string, trackId: string) {
    saveChange("移除歌曲", async () => { const detail = mapPlaylist(await api.removeFromPlaylist(id, trackId)); setPlaylists((items) => items.map((item) => item.id === id ? detail : item)); });
  }
  function moveQueue(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= queue.length) return;
    setQueue((previous) => { const next = [...previous]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  }

  useEffect(() => { setOrderDraft(null); }, [pageRoute]);
  const preferenceSnapshot = useRef(session.preferences);
  preferenceSnapshot.current = { dense, darkMode, volume, shuffle, repeat, queue: queue.map((track) => track.id).slice(0, 10000), currentId, position };
  const preferenceWrites = useRef(Promise.resolve());
  function persistPreferences() {
    if (!player.hydrated) return;
    const snapshot = { ...preferenceSnapshot.current };
    preferenceWrites.current = preferenceWrites.current.catch(() => undefined).then(async () => { await api.preferences(snapshot); }).catch(() => { announce("播放与界面偏好暂未保存，连接恢复后会再次尝试。"); });
  }
  useEffect(() => {
    if (!player.hydrated) return;
    const timer = window.setTimeout(persistPreferences, 800);
    return () => window.clearTimeout(timer);
  }, [player.hydrated, player.seekRevision, dense, darkMode, volume, shuffle, repeat, queue, currentId, isPlaying]);
  useEffect(() => {
    if (!player.hydrated || !currentId || !isPlaying) return;
    const timer = window.setInterval(persistPreferences, 10_000);
    return () => window.clearInterval(timer);
  }, [player.hydrated, currentId, isPlaying]);
  useEffect(() => {
    if (!player.hydrated) return;
    window.addEventListener("online", persistPreferences);
    return () => window.removeEventListener("online", persistPreferences);
  }, [player.hydrated]);
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    // Match the search edge to the content across overlay and classic scrollbars.
    const syncScrollbarWidth = () => setContentScrollbarWidth(main.offsetWidth - main.clientWidth);
    const observer = new ResizeObserver(syncScrollbarWidth);
    observer.observe(main);
    syncScrollbarWidth();
    return () => observer.disconnect();
  }, [loginRoute]);
  useEffect(() => {
    const update = () => {
      const nextRoute = readRoute();
      const nextQuery = readSearchQuery();
      setRoute(nextRoute); setQuery(nextQuery); setSearchCommitted(Boolean(nextQuery)); setSearchFocused(false);
      setPageLimit(40); setMenu(null); setMobileNavOpen(false); setCheckStatus({ service: "idle", directory: "idle", partial: "idle" });

    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => { setMobileNavOpen(false); }, [isMobile]);
  useEffect(() => () => { if (retryTimer.current) window.clearTimeout(retryTimer.current); }, []);
  useEffect(() => {
    if (route !== "playing" && previousPage.current !== pageRoute) mainRef.current?.scrollTo({ top: 0 });
    if (route !== "playing" && browseRoute.current !== pageRoute) { setAlbumDiscFilter("全部"); setFormatFilter("全部"); browseRoute.current = pageRoute; }
    previousPage.current = pageRoute;
  }, [route, pageRoute]);
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(""), 3200); return () => window.clearTimeout(id); }, [toast]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (loginRoute) return;
      const target = event.target as HTMLElement;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) { event.preventDefault(); searchRef.current?.focus(); return; }
      if (event.key === "Escape") { setMenu(null); setMobileNavOpen(false); if ((searching || searchSuggestionsOpen) && !document.querySelector("dialog[open]")) clearSearch(); }
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) || target.isContentEditable || modal || queueOpen) return;
      if (event.code === "Space") { event.preventDefault(); togglePlay(); }
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [modal, queueOpen, searchSuggestionsOpen, searching, section, phase, hasCurrent, loginRoute]);
  useEffect(() => {
    if (!searchFocused) return;
    const close = (event: MouseEvent) => {
      const field = searchRef.current?.closest(".search-control");
      if (field && !field.contains(event.target as Node)) setSearchFocused(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [searchFocused]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("resize", close); mainRef.current?.addEventListener("scroll", close);
    return () => { window.removeEventListener("resize", close); mainRef.current?.removeEventListener("scroll", close); };
  }, [menu]);

  function sectionHeading(title: string, subtitle?: string, action?: ReactNode) {
    return <div className="section-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>;
  }
  function albumCard(album: Album) {
    const list = albumTracks(album.id);
    return <article className="album-card" key={album.id}>
      <div className="album-cover-wrap artwork-card">
        <button className="cover-link" onClick={() => navigate(`album/${encodeURIComponent(album.id)}`)} aria-label={`打开专辑 ${album.name}`}><Cover album={album} /></button>
        <button className="cover-play" aria-label={`播放专辑 ${album.name}`} disabled={!list.length} onClick={() => play(list[0], list)}><Play fill="currentColor" /></button>
      </div>
      <button className="album-name" title={album.title} onClick={() => navigate(`album/${encodeURIComponent(album.id)}`)}>{album.name}</button>
      <p>{album.artist}</p><div className="album-metadata-line"><span className="album-year">{yearLabel(album.year)} · {album.genre}</span></div>
    </article>;
  }
  function trackList(list: Track[], options: { compact?: boolean; hideAlbum?: boolean; playlistId?: string; limit?: number; emptyState?: ReactNode } = {}) {
    const visible = list.slice(0, options.limit ?? pageLimit);
    return <div className={`track-list ${options.compact ? "compact" : ""} ${options.hideAlbum ? "hide-album" : ""}`}>
      {!options.compact && list.length > 0 && <div className="track-table-head"><span>#</span><span>歌曲 / 艺人</span>{!options.hideAlbum && <span>专辑</span>}<span>音质</span><span><Clock3 size={14} /><span className="sr-only">时长</span></span><span /></div>}
      {visible.map((track, index) => {
        const album = albumMap.get(track.albumId)!;
        const active = track.id === currentId;
        return <div className={`track-row ${active ? "current-track" : ""}`} key={track.id}>
          <button className="track-number" aria-label={`${active && isPlaying ? "暂停" : "播放"} ${displayTitle(track)}`} onClick={() => active ? togglePlay() : play(track, list)}>
            {active ? <span className={`equalizer ${isPlaying ? "is-playing" : "is-paused"}`} aria-hidden="true"><i /><i /><i /></span> : <><span>{String(index + 1).padStart(2, "0")}</span><Play size={14} fill="currentColor" /></>}
          </button>
          <button className="track-identity" onClick={() => active ? togglePlay() : play(track, list)} title={track.title}>
            {!options.hideAlbum && <Cover album={album} />}
            <span><strong>{displayTitle(track)}</strong><small>{track.artist}</small></span>
          </button>
          {!options.hideAlbum && <button className="track-album" onClick={() => navigate(`album/${encodeURIComponent(album.id)}`)}>{album.name}</button>}
          <span className="quality-tag">{track.format || "—"}</span><span className="track-duration">{trackTime(track.duration)}</span>
          <div className="track-actions"><IconButton label={favorites.has(track.id) ? `取消收藏 ${displayTitle(track)}` : `收藏 ${displayTitle(track)}`} active={favorites.has(track.id)} disabled={writeState === "saving"} onClick={() => toggleFavorite(track.id)}><Heart fill={favorites.has(track.id) ? "currentColor" : "none"} /></IconButton>
            {options.playlistId ? <IconButton label={`从歌单移除 ${displayTitle(track)}`} disabled={writeState === "saving"} onClick={() => removeFromPlaylist(options.playlistId!, track.id)}><X /></IconButton> : <button className="icon-button track-more" aria-label={`${displayTitle(track)} 的更多操作`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ track, x: Math.min(rect.right - 210, window.innerWidth - 226), y: Math.min(rect.bottom + 4, window.innerHeight - 235) }); }}><MoreHorizontal /></button>}
          </div>
        </div>;
      })}
      {!list.length && (options.emptyState ?? <StatePanel className="state-panel-list" icon={Music2} title="这里还很安静" description="去曲库找些喜欢的音乐吧。" actions={[{ label: "浏览专辑", onClick: () => navigate("albums") }]} />)}
      {!options.limit && list.length > pageLimit && <div className="load-more-region">{moreState === "error" && <p role="alert">后面的歌曲暂时没有载入，已经显示的歌曲仍可播放。</p>}<button className="load-more" disabled={moreState === "loading"} onClick={loadMore}>{moreState === "loading" ? <><LoaderCircle className="button-spinner" />正在载入…</> : moreState === "error" ? "重新载入后续歌曲" : <>再显示 {Math.min(60, list.length - pageLimit)} 首 <ChevronDown /></>}</button></div>}
    </div>;
  }
  function pageHeading(kicker: string, title: string, description: string, action?: ReactNode) {
    return <div className="page-heading"><div><span className="eyebrow">{kicker}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;
  }
  const resourceLabels: Record<RoomResource, string> = { tracks: "歌曲", albums: "专辑", playlists: "歌单", summary: "扫描记录", directory: "目录信息" };
  function resourceNotice(resource: RoomResource) {
    const state = data.resources[resource];
    if (state.status === "ready") return null;
    const busy = state.status === "loading";
    const label = resourceLabels[resource];
    return <div className="inline-request-state" role={busy ? "status" : "alert"} aria-busy={busy}>
      {busy ? <LoaderCircle className="button-spinner" /> : <AlertTriangle />}
      <span>{busy ? `正在载入${label}…` : `${label}暂时没有载入，${state.hasValue ? "已显示的内容仍保留着。" : "其他内容仍可浏览。"}`}</span>
      <button className="button subtle" disabled={busy} aria-label={`重新载入${label}`} onClick={() => { void data.refresh(resource).catch(() => undefined); }}>{busy ? "载入中" : "重试"}</button>
    </div>;
  }
  function resourceUnavailable(resource: RoomResource, detail = false) {
    const state = data.resources[resource];
    const label = resourceLabels[resource];
    return <>{pageHeading("音乐库", label === "歌曲" ? "所有歌曲" : label, "留一点时间，给喜欢的声音。")}
      {state.status === "loading" ? <ContentSkeleton detail={detail} /> : <StatePanel tone="error" icon={AlertTriangle} title={`暂时无法载入${label}`} description={`${state.error} 已有内容仍然保留，可以稍后重试或继续浏览音乐室。`} actions={[{ label: `重新载入${label}`, onClick: () => { void data.refresh(resource).catch(() => undefined); } }, { label: "回到首页", variant: "subtle", onClick: () => navigate("home") }]} />}
    </>;
  }
  function playButton(list: Track[], label = "播放全部") {
    return <button className="button primary" disabled={!list.length} onClick={() => play(list[0], list)}><Play size={16} fill="currentColor" />{label}</button>;
  }
  function shuffleButton(list: Track[]) {
    return <button className="button subtle" disabled={!list.length} onClick={() => { setShuffle(true); play(list[Math.floor(Math.random() * list.length)], list); }}><Shuffle />随机播放</button>;
  }
  function collectionLabel(title: string, count: string) {
    return <div className="collection-label"><h2>{title}</h2><span>{count}</span></div>;
  }
  function openCreatePlaylist(trackId?: string) {
    setNewPlaylistName("");
    setPlaylistError("");
    setModal(trackId ? { type: "create", trackId } : { type: "create" });
  }
  function openPlaylistAdd(playlistId: string) {
    setPlaylistTrackQuery("");
    setModal({ type: "playlist-add", playlistId });
  }
  function renderLibraryEmpty(className = "") {
    if (!canManageLibrary) return <StatePanel className={className} icon={Library} eyebrow="共享音乐库" title="音乐正在等一次相遇" description="管理员尚未连接音乐目录，或扫描还没有完成。请联系音乐室管理员添加音乐，你可以先整理自己的歌单。" actions={[{ label: "我的歌单", onClick: () => navigate("playlists") }, { label: "我的账号", variant: "subtle", onClick: () => navigate("account") }]} />;
    return <StatePanel className={className} icon={Library} eyebrow="本地音乐库" title="曲库里还没有内容" description="先扫描或连接一个音乐目录，专辑、歌曲和艺人才会出现在这里。" actions={[{ label: "打开设置", onClick: () => setModal({ type: "settings" }) }, { label: "先逛逛歌单", variant: "subtle", onClick: () => navigate("playlists") }]} />;
  }
  function collectionPlaylistCard(playlist: Playlist) {
    const list = playlist.trackIds.map((id) => trackMap.get(id)!).filter(Boolean);
    return <article className="playlist-collection-card" key={playlist.id}>
      <div className="playlist-collection-art artwork-card">
        <button aria-label={`打开歌单 ${playlist.name}`} onClick={() => navigate(`playlist/${playlist.id}`)}><PlaylistArt playlist={playlist} /></button>
        <button className="playlist-quick-play" aria-label={`播放歌单 ${playlist.name}`} disabled={!list.length || Boolean(playlist.detailError)} onClick={() => play(list[0], list)}><Play fill="currentColor" /></button>
      </div>
      <div className="playlist-collection-copy"><button className="playlist-title" onClick={() => navigate(`playlist/${playlist.id}`)}>{playlist.name}</button><p>{playlist.description}</p><span><ListMusic />{playlist.detailError ? "内容暂未载入，打开后重试" : <>{list.length} 首<span>·</span>{durationLabel(list.reduce((sum, track) => sum + track.duration, 0))}</>}</span></div>
    </article>;
  }
  function renderHome() {
    if (!albums.length && !tracks.length && data.resources.tracks.hasValue && data.resources.albums.hasValue) return renderLibraryEmpty();
    return <>
      <div className="home-intro"><span className="eyebrow">你的音乐空间</span><h1>音乐，刚刚好。</h1><p>留一点时间，给喜欢的声音。</p></div>
      {featured && <section className="home-highlights" aria-label="聆听推荐">
        <article className="featured-record">
          <div className="featured-copy">
            <span className="featured-kicker"><Disc3 />今日精选</span>
            <h2>{featured.name}</h2>
            <p className="featured-credit">{featured.artist} · {yearLabel(featured.year)}</p>
            <p className="featured-description">从熟悉的旋律出发，<br />重返故事里的世界。</p>
            <div className="featured-actions">
              <button className="button primary" onClick={() => play(albumTracks(featured.id)[0], albumTracks(featured.id))}><Play size={16} fill="currentColor" />播放专辑</button>
              <button className="text-button" onClick={() => navigate(`album/${encodeURIComponent(featured.id)}`)}>查看专辑<ChevronRight /></button>
            </div>
          </div>
          <button className="featured-artwork" aria-label={`查看今日精选 ${featured.name}`} onClick={() => navigate(`album/${encodeURIComponent(featured.id)}`)}><Cover album={featured} lazy={false} /></button>
        </article>
        {hasCurrent ? <article className="resume-card">
          <div className="resume-heading"><span>继续聆听</span><Headphones /></div>
          <button className="resume-artwork" aria-label={`查看正在播放的专辑 ${currentAlbum.name}`} onClick={() => navigate(`album/${encodeURIComponent(currentAlbum.id)}`)}><Cover album={currentAlbum} lazy={false} /></button>
          <div className="resume-details"><strong title={current.title}>{displayTitle(current)}</strong><span>{current.artist}</span></div>
          <IconButton className="resume-control" label={isPlaying ? "暂停当前歌曲" : player.hasEnded ? "重新播放" : "继续播放"} onClick={togglePlay}>{isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</IconButton>
          <div className="resume-progress" aria-hidden="true"><span style={{ width: `${position / Math.max(1, player.duration || current.duration) * 100}%` }} /></div>
        </article> : <article className="resume-card resume-empty"><Headphones /><h2>从第一首开始</h2><p>还没有聆听记录。<br />挑一张喜欢的唱片，留下今天的声音。</p><button className="button subtle" onClick={() => navigate("albums")}>去听听</button></article>}
      </section>}
      <section className="home-albums">{sectionHeading("最近加入", "每一次收藏，都值得认真听见。", <button className="text-button" onClick={() => navigate("albums")}>全部专辑<ChevronRight /></button>)}{resourceNotice("albums")}<div className="album-grid home-album-grid">{albums.slice(0, 5).map(albumCard)}</div></section>
      <section className="home-playlists">{sectionHeading("为不同的时刻", "你的生活，自己的配乐。", <button className="text-button" onClick={() => navigate("playlists")}>我的歌单<ChevronRight /></button>)}{resourceNotice("playlists")}{playlists.length ? <div className="playlist-collection-grid">{playlists.slice(0, 3).map(collectionPlaylistCard)}</div> : data.resources.playlists.status === "ready" && <div className="home-empty-collection"><ListMusic /><div><h3>给今天，留一张歌单</h3><p>把喜欢的音乐慢慢收集起来。</p></div><button className="button subtle" onClick={() => openCreatePlaylist()}>新建歌单</button></div>}</section>
      <section className="home-collection">
        <div>{sectionHeading("一听，就很喜欢", "让这些旋律多陪你一会儿。", <button className="text-button" onClick={() => navigate("favorites")}>全部收藏<ChevronRight /></button>)}{resourceNotice("tracks")}<div className="home-favorites-list">{data.resources.tracks.hasValue && trackList(tracks.filter((track) => favorites.has(track.id)).slice(0, 4), { compact: true, limit: 4 })}</div></div>
        <aside className="library-summary"><span className="eyebrow">本地音乐库</span><h3>你的音乐，都在这里。</h3><div className="library-summary-stats"><div><strong>{data.resources.tracks.hasValue ? tracks.length.toLocaleString() : "—"}</strong><span>首歌曲</span></div><div><strong>{data.resources.albums.hasValue ? albums.length : "—"}</strong><span>张专辑</span></div></div><p>{durationLabel(tracks.reduce((sum, track) => sum + track.duration, 0))}，慢慢听。</p><button className="text-button" onClick={() => setModal({ type: "info" })}>关于这间音乐室<ChevronRight /></button></aside>
      </section>
      <footer className="page-footer"><Disc3 size={15} /><span>你的音乐，你的节奏。</span><span>开听</span></footer>
    </>;
  }
  function renderAlbums() {
    const result = albums;
    return <>
      {pageHeading("音乐库 / 专辑", "你的唱片架", `${albums.length} 张专辑，收藏着不同的世界。`, shuffleButton(tracks))}
      {result.length ? <div className="album-grid collection-grid">{result.map(albumCard)}</div> : renderLibraryEmpty()}
    </>;
  }
  function renderAlbum(album?: Album) {
    if (!album) return renderNotFound("album");
    const list = albumTracks(album.id);
    const discs = [...new Set(list.map((track) => track.disc))];
    const filtered = albumDiscFilter.startsWith("Disc ") ? list.filter((track) => track.disc === Number(albumDiscFilter.slice(5))) : list;
    return <>
      <button className="back-link" onClick={() => navigate("albums")}><ArrowLeft />回到唱片架</button>
      <section className="detail-hero album-detail">
        <div className="album-detail-art artwork-card"><Cover album={album} lazy={false} /></div>
        <div className="detail-copy"><span className="eyebrow">专辑 · {album.genre} · {yearLabel(album.year)}</span><h1>{album.name}</h1>{album.title.trim() !== album.name.trim() && <p className="original-title">{album.title}</p>}<button className="detail-artist" onClick={() => navigate(`artist/${encodeURIComponent(album.artist)}`)}>{album.artist}<ChevronRight /></button><p className="detail-meta"><span>{album.trackCount} 首歌曲</span><span>·</span><span>{durationLabel(album.duration)}</span>{album.lossless && <span className="lossless"><Disc3 />无损音质</span>}</p><div className="detail-actions">{playButton(list)}{shuffleButton(list)}</div>{canManageLibrary && <button className="album-metadata-action" onClick={() => setModal({ type: "album-metadata", albumId: album.id })}><Pencil />编辑专辑信息</button>}</div>
      </section>
      <section className="detail-track-section">
        <div className="detail-track-heading">{collectionLabel("专辑曲目", data.resources.tracks.hasValue ? `${filtered.length} 首` : "待载入")}
          {discs.length > 1 && <div className="filter-pills disc-tabs" aria-label="选择碟片"><button aria-pressed={albumDiscFilter === "全部"} className={albumDiscFilter === "全部" ? "selected" : ""} onClick={() => { setAlbumDiscFilter("全部"); setPageLimit(40); }}>全部</button>{discs.map((disc) => <button key={disc} aria-pressed={albumDiscFilter === `Disc ${disc}`} className={albumDiscFilter === `Disc ${disc}` ? "selected" : ""} onClick={() => { setAlbumDiscFilter(`Disc ${disc}`); setPageLimit(40); }}>Disc {disc}</button>)}</div>}
        </div>
        {resourceNotice("tracks")}
        {filtered.length ? trackList(filtered, { hideAlbum: true }) : data.resources.tracks.hasValue && <StatePanel className="state-panel-list" icon={Disc3} title="这个碟片还没有歌曲" description="换一张碟片，或者回到专辑列表继续浏览。" actions={[{ label: "回到唱片架", onClick: () => navigate("albums") }]} />}
      </section>
      <p className="detail-endnote">{yearLabel(album.year)} · {album.genre} · {album.trackCount} 首歌曲</p>
    </>;
  }
  function renderArtists() {
    return <>{pageHeading("BEHIND THE MUSIC", "旋律背后的人", "循着一个名字，听见更多喜欢的声音。")}
      {resourceNotice("albums")}{resourceNotice("tracks")}
      {artistIndex.length ? <div className="artist-grid">{artistIndex.map((artist) => <button className="artist-card" key={artist.name} aria-label={`查看艺人 ${artist.name}`} onClick={() => navigate(`artist/${encodeURIComponent(artist.name)}`)}><div className="artist-art artwork-card"><Cover album={albumMap.get([...artist.albumIds][0]) ?? emptyAlbum} /></div><h2 title={artist.name}>{artist.name}</h2><p>{artist.albumIds.size} 张专辑 · {data.resources.tracks.hasValue ? artist.trackIds.size : "—"} 首歌曲</p></button>)}</div> : data.resources.tracks.hasValue && data.resources.albums.hasValue && renderLibraryEmpty()}</>;
  }
  function renderArtist(id: string) {
    let name = ""; try { name = decodeURIComponent(id); } catch { return renderNotFound("artist"); }
    const artist = artistIndex.find((item) => item.name === name);
    if (!artist) return !data.resources.tracks.hasValue ? resourceUnavailable("tracks") : !data.resources.albums.hasValue ? resourceUnavailable("albums") : renderNotFound("artist");
    const list = tracks.filter((track) => artist.trackIds.has(track.id));
    const results = [...artist.albumIds].map((id) => albumMap.get(id)).filter((album): album is Album => Boolean(album));
    return <>
      <button className="back-link" onClick={() => navigate("artists")}><ArrowLeft />全部艺人</button>
      {resourceNotice("albums")}{resourceNotice("tracks")}
      <section className="detail-hero artist-profile"><div className="artist-detail-art artwork-card"><Cover album={results[0]} lazy={false} /></div><div className="detail-copy"><span className="eyebrow">艺人作品</span><h1>{name}</h1><p className="playlist-description">循着熟悉的名字，听见更多喜欢的声音。</p><p className="detail-meta">{results.length} 张专辑<span>·</span>{data.resources.tracks.hasValue ? list.length : "—"} 首作品</p><div className="detail-actions">{playButton(list)}{shuffleButton(list)}</div></div></section>
      <section>{collectionLabel("专辑与参与作品", `${results.length} 张`)}<div className="album-grid collection-grid">{results.map(albumCard)}</div></section>
      <section className="artist-tracks">{collectionLabel("从这些旋律开始", data.resources.tracks.hasValue ? `${Math.min(12, list.length)} 首` : "待载入")}{list.length ? trackList(list, { limit: 12 }) : data.resources.tracks.hasValue && <StatePanel className="state-panel-list" icon={Music2} title="这位艺人还没有歌曲" description="回到艺人列表，看看其他创作者的作品。" actions={[{ label: "回到艺人", onClick: () => navigate("artists") }]} />}</section>
    </>;
  }
  function renderPlaylist(playlist?: Playlist) {
    if (!playlist) return renderNotFound("playlist");
    if (playlist.detailError) {
      const busy = Boolean(playlist.detailLoading) || data.resources.playlists.status === "loading";
      return <><button className="back-link" onClick={() => navigate("playlists")}><ArrowLeft />我的歌单</button>
        {pageHeading("私人歌单", playlist.name, "你的歌单仍然保留着。")}
        <StatePanel tone="error" icon={ListMusic} title="这张歌单暂时没有载入" description={`${playlist.detailError} 其他歌单与曲库仍可浏览。`} busy={busy} actions={[{ label: busy ? "正在载入…" : "重新载入歌单", busy, disabled: busy, onClick: () => { void data.refreshPlaylist(playlist.id); } }, { label: "我的歌单", variant: "subtle", onClick: () => navigate("playlists") }]} />
      </>;
    }
    if (!data.resources.tracks.hasValue) return resourceUnavailable("tracks");
    const list = playlist.trackIds.map((id) => trackMap.get(id)!).filter(Boolean);
    return <>
      {resourceNotice("tracks")}
      <button className="back-link" onClick={() => navigate("playlists")}><ArrowLeft />我的歌单</button>
      <section className={`detail-hero playlist-detail${list.length ? "" : " is-empty"}`}><div className="playlist-detail-art artwork-card"><PlaylistArt playlist={playlist} /></div><div className="detail-copy"><span className="eyebrow">私人歌单</span><h1>{playlist.name}</h1><p className="playlist-description">{playlist.description}</p><p className="detail-meta">{list.length} 首歌曲<span>·</span>{durationLabel(list.reduce((sum, track) => sum + track.duration, 0))}</p><div className="detail-actions">{playButton(list)}{shuffleButton(list)}</div><div className="playlist-management"><button onClick={() => { setNewPlaylistName(playlist.name); setPlaylistError(""); setModal({ type: "rename", playlistId: playlist.id }); }}><Pencil />重命名</button><button onClick={() => setModal({ type: "delete", playlistId: playlist.id })}><Trash2 />删除歌单</button></div></div></section>
      <section className={`playlist-tracks${list.length ? "" : " is-empty"}`}><div className="detail-track-heading">{collectionLabel("歌单中的音乐", `${list.length} 首`)}{list.length > 0 && <div className="playlist-management">{list.length > 1 && !orderDraft && <button onClick={() => setOrderDraft([...playlist.trackIds])}><ListMusic />调整顺序</button>}<button className="text-button add-tracks" disabled={Boolean(orderDraft)} onClick={() => openPlaylistAdd(playlist.id)}><Plus />添加歌曲</button></div>}</div>
      {orderDraft ? <PlaylistOrderEditor
        items={orderDraft.map((id) => { const track = trackMap.get(id)!; return { id, title: displayTitle(track), artist: track.artist, artwork: <Cover album={(albumMap.get(track.albumId) ?? emptyAlbum)} /> }; })}
        writeState={writeState} onChange={setOrderDraft}
        onCancel={() => { cancelWrite(); setOrderDraft(null); }}
        onSave={() => saveChange("保存歌曲顺序", async () => { const detail = mapPlaylist(await api.reorderPlaylist(playlist.id, orderDraft, playlist.revision)); setPlaylists((items) => items.map((item) => item.id === playlist.id ? detail : item)); setOrderDraft(null); })}
      />
      : list.length ? trackList(list, { playlistId: playlist.id }) : <StatePanel className="state-panel-list playlist-empty-state" icon={ListMusic} title="这张歌单还没有歌曲" description={"从曲库挑几首喜欢的旋律，\n给这个时刻留一份声音。"} actions={[{ label: "添加歌曲", onClick: () => openPlaylistAdd(playlist.id) }, { label: "浏览专辑", variant: "subtle", onClick: () => navigate("albums") }]} />}</section>
    </>;
  }
  function renderPlaylists() {
    return <>
      {pageHeading("音乐库 / 私人歌单", "给生活，一点配乐", `${playlists.length} 张歌单，为不同的时刻准备。`, playlists.length > 0 ? <button className="button primary" onClick={() => openCreatePlaylist()}><Plus />新建歌单</button> : undefined)}
      {playlists.length ? <div className="playlist-collection-grid">{playlists.map(collectionPlaylistCard)}</div> : <StatePanel className="playlists-empty-state" icon={ListMusic} title="还没有私人歌单" description={"为某个时刻起一个名字，\n把喜欢的歌曲慢慢收进来。"} actions={[{ label: "新建歌单", onClick: () => openCreatePlaylist() }, { label: "浏览专辑", variant: "subtle", onClick: () => navigate("albums") }]} />}
    </>;
  }
  function renderFavorites() {
    const list = tracks.filter((track) => favorites.has(track.id));
    return <>
      <section className={`detail-hero favorites-detail${list.length ? "" : " is-empty"}`}>
        <div className="favorites-detail-art artwork-card">{list.length ? <PlaylistArt playlist={{ id: "favorites", name: "我的收藏", description: "", trackIds: list.map((track) => track.id) }} /> : <div className="favorites-empty-art"><Heart /></div>}</div>
        <div className="detail-copy"><span className="eyebrow"><Heart size={14} fill="currentColor" />我的收藏</span><h1>一听，就很喜欢</h1><p className="playlist-description">喜欢的音乐，值得一听再听。</p><p className="detail-meta">{list.length} 首歌曲<span>·</span>{durationLabel(list.reduce((sum, track) => sum + track.duration, 0))}</p><div className="detail-actions">{playButton(list)}{shuffleButton(list)}</div></div>
      </section>
      <section className={`favorites-tracks${list.length ? "" : " is-empty"}`}>{collectionLabel("收藏的歌曲", `${list.length} 首`)}{list.length ? trackList(list) : <StatePanel className="state-panel-list favorites-empty-state" icon={Heart} title="还没有收藏歌曲" description={"点一下歌曲旁的心形图标，\n把喜欢的旋律收藏在这里。"} actions={[{ label: "浏览歌曲", onClick: () => navigate("songs") }, { label: "浏览专辑", variant: "subtle", onClick: () => navigate("albums") }]} />}</section>
    </>;
  }
  function renderSongs() {
    const list = tracks.filter((track) => formatFilter === "全部" || track.format === formatFilter);
    if (!tracks.length) return <>{pageHeading("音乐库 / 歌曲", "所有歌曲", "曲库还没有可播放的内容。")}{renderLibraryEmpty()}</>;
    return <>
      {pageHeading("音乐库 / 歌曲", "所有歌曲", `${tracks.length.toLocaleString()} 首旋律，随时为你响起。`, playButton(list))}
      <div className="collection-toolbar songs-filter-bar"><div className="filter-pills" aria-label="筛选音频格式">{["全部", ...Array.from(new Set(tracks.map((track) => track.format))).sort()].map((item) => <button key={item} aria-pressed={formatFilter === item} className={formatFilter === item ? "selected" : ""} onClick={() => { setFormatFilter(item); setPageLimit(40); }}>{item === "全部" ? "全部格式" : item}</button>)}</div><span className="result-count">{list.length.toLocaleString()} 首歌曲</span></div>
      {list.length ? trackList(list) : <StatePanel className="state-panel-list" icon={Music2} title={`还没有 ${formatFilter} 格式的歌曲`} description="换个格式，继续发现你的音乐。" actions={[{ label: "查看全部歌曲", variant: "subtle", onClick: () => setFormatFilter("全部") }]} />}
    </>;
  }
  function getSearchMatches(value = query) {
    const term = value.trim().toLocaleLowerCase();
    const matchingArtists = artistIndex.map((artist) => artist.name).filter((artist) => artist.toLocaleLowerCase().includes(term));
    const matchingAlbums = albums.filter((album) => `${album.name} ${album.title} ${album.artist} ${album.genre}`.toLocaleLowerCase().includes(term));
    const matchingTracks = tracks.filter((track) => `${track.title} ${track.artist} ${albumMap.get(track.albumId)?.name}`.toLocaleLowerCase().includes(term));
    return { matchingArtists, matchingAlbums, matchingTracks };
  }
  function commitSearch() {
    const term = query.trim();
    if (!term) return;
    setSearchCommitted(true);
    setSearchFocused(false);
    setPageLimit(40);
    window.location.hash = `/search?q=${encodeURIComponent(term)}`;
  }
  function renderSearchSuggestions() {
    if (!searchSuggestionsOpen) return null;
    const { matchingArtists, matchingAlbums, matchingTracks } = getSearchMatches();
    const hasMatches = matchingArtists.length > 0 || matchingAlbums.length > 0 || matchingTracks.length > 0;
    return <div className="search-suggestions" role="region" aria-label="搜索候选">
      <div className="search-suggestions-heading"><span>快速找到</span><button type="button" onClick={commitSearch}>查看全部</button></div>
      {!hasMatches ? <div className="search-suggestions-empty"><Search /><span>没有匹配结果，按 Enter 查看完整搜索。</span></div> : <div className="search-suggestions-groups">
        {matchingArtists.slice(0, 2).map((artist) => <button type="button" className="search-suggestion-row" key={`artist-${artist}`} onClick={() => navigate(`artist/${encodeURIComponent(artist)}`)}><span className="search-suggestion-icon"><UserRound /></span><span><strong>{artist}</strong><small>艺人</small></span><ChevronRight /></button>)}
        {matchingAlbums.slice(0, 3).map((album) => <button type="button" className="search-suggestion-row" key={`album-${album.id}`} onClick={() => navigate(`album/${encodeURIComponent(album.id)}`)}><Cover album={album} /><span><strong>{album.name}</strong><small>{album.artist} · 专辑</small></span><ChevronRight /></button>)}
        {matchingTracks.slice(0, 4).map((track) => <button type="button" className="search-suggestion-row" key={`track-${track.id}`} onClick={() => { play(track); clearSearch(); }}><Cover album={(albumMap.get(track.albumId) ?? emptyAlbum)} /><span><strong>{displayTitle(track)}</strong><small>{track.artist} · 歌曲</small></span><Play fill="currentColor" /></button>)}
      </div>}
      {hasMatches && <div className="search-suggestions-footer"><kbd>Enter</kbd><span>查看全部搜索结果</span></div>}
    </div>;
  }
  function renderSearch() {
    const { matchingArtists, matchingAlbums, matchingTracks } = getSearchMatches();
    const partial = data.resources.albums.status !== "ready" || data.resources.tracks.status !== "ready";
    return <>{pageHeading("音乐库 / 搜索", `寻找「${query.trim()}」`, `${matchingArtists.length} 位艺人 · ${matchingAlbums.length} 张专辑 · ${matchingTracks.length} 首歌曲${partial ? " · 部分结果暂未载入" : ""}`)}
      {!partial && !matchingArtists.length && !matchingAlbums.length && !matchingTracks.length ? <StatePanel className="search-empty" icon={Search} eyebrow="搜索" title="还没有找到这段旋律" description="试试其他歌曲名称、专辑或艺人。" actions={[{ label: "重新搜索", variant: "subtle", onClick: () => clearSearch(true) }, { label: "回到首页", onClick: () => navigate("home") }]} /> : <>
        {matchingArtists.length > 0 && <section className="search-artists">{sectionHeading("艺人", `${matchingArtists.length} 位`)}<div className="search-artist-list">{matchingArtists.map((name) => <button key={name} onClick={() => navigate(`artist/${encodeURIComponent(name)}`)}><span><UserRound /></span><strong>{name}</strong><ChevronRight /></button>)}</div></section>}
        <section className="search-albums">{sectionHeading("专辑", data.resources.albums.hasValue ? `${matchingAlbums.length} 张` : undefined)}{resourceNotice("albums")}{matchingAlbums.length ? <div className="album-grid collection-grid">{matchingAlbums.map(albumCard)}</div> : data.resources.albums.status === "ready" && <p className="muted-copy">没有匹配的专辑。</p>}</section>
        {(matchingTracks.length > 0 || data.resources.tracks.status !== "ready") && <section>{sectionHeading("歌曲", data.resources.tracks.hasValue ? `${matchingTracks.length} 首` : undefined, playButton(matchingTracks))}{resourceNotice("tracks")}{matchingTracks.length > 0 && trackList(matchingTracks)}</section>}
      </>}
    </>;
  }
  function renderNotFound(kind: "page" | "album" | "artist" | "playlist" = "page") {
    const copy = {
      page: { eyebrow: "404 · 页面不存在", title: "这条路还没有唱片", description: "你访问的页面已经离开曲库，回到音乐室继续浏览吧。" },
      album: { eyebrow: "404 · 专辑不存在", title: "这张唱片暂时不在架上", description: "它可能被移出了当前曲库，或者链接已经过期。" },
      artist: { eyebrow: "404 · 艺人不存在", title: "还没有找到这位艺人", description: "换个名字搜索，或者回到艺人列表继续发现。" },
      playlist: { eyebrow: "404 · 歌单不存在", title: "这张歌单暂时找不到", description: "它可能已经被删除，或者只存在于另一个音乐室。" }
    }[kind];
    return <StatePanel tone="error" icon={kind === "artist" ? UserRound : kind === "playlist" ? ListMusic : Disc3} eyebrow={copy.eyebrow} title={copy.title} description={copy.description} actions={[{ label: "回到首页", onClick: () => navigate("home") }, { label: "浏览专辑", variant: "subtle", onClick: () => navigate("albums") }]} />;
  }
  function renderLibraryError() {
    const checking = checkStatus.service === "checking";
    return <StatePanel tone="error" icon={Info} eyebrow="曲库读取失败" title="暂时无法打开音乐库" description="本地曲库没有响应，歌曲和封面暂时无法载入。可以先检查目录挂载状态，或稍后重试。" busy={checking} actions={[{ label: checking ? "正在检查…" : "重新尝试", onClick: () => retryLibrary("service"), disabled: checking, busy: checking }, { label: "检查目录", variant: "subtle", onClick: () => navigate("directory-unavailable") }, { label: "回到首页", variant: "subtle", onClick: () => navigate("home") }]} />;
  }
  function renderLibraryLoading() {
    const scanningDirectory = directoryConfigured;
    return <StatePanel className="state-panel-loading" busy icon={LoaderCircle} eyebrow={scanningDirectory ? "正在扫描音乐目录" : "正在准备音乐室"} title={scanningDirectory ? "正在扫描你的音乐" : "正在载入你的音乐"} description={scanningDirectory ? "目录已连接，正在读取专辑、歌曲和封面，请稍候。" : "正在读取专辑、歌曲和封面，请稍候。"} />;
  }
  function renderDirectoryUnavailable() {
    const checking = checkStatus.directory === "checking";
    const blockedPath = musicDirectory;
    return <>
      {pageHeading("音乐库 / 目录", "音乐目录暂时不可访问", "检查挂载状态与访问权限，连接后继续聆听。")}
      <section className="incident-state" aria-label="音乐目录不可访问">
        <StatePanel className="directory-unavailable-state" tone="error" icon={FolderOpen} eyebrow="目录不可访问" title="暂时读不到这处音乐目录" description={`开听无法读取 ${blockedPath}。已保存的收藏和歌单不会受影响；连接恢复后可以继续扫描。`} busy={checking} actions={[{ label: checking ? "正在检查…" : "重新检查", onClick: () => retryLibrary("directory"), disabled: checking, busy: checking }, { label: "选择其他目录", variant: "subtle", onClick: () => { setDirectorySelection(musicDirectory); setModal({ type: "directory", returnTo: "directory-unavailable" }); } }, { label: "回到首页", variant: "subtle", onClick: () => navigate("home") }]} />
        <div className="incident-meta" aria-label="目录检查信息">
          <div><span>当前目录</span><strong>{blockedPath}</strong></div>
          <div><span>可能原因</span><strong>NAS 未挂载或访问权限已改变</strong></div>
          <div><span>建议处理</span><strong>确认网络连接和目录权限，再重新检查</strong></div>
        </div>
      </section>
    </>;
  }
  function renderPartialScan() {
    const checking = scanStarting;
    const inspected = data.scanJob?.scannedFiles ?? tracks.length;
    return <>
      {pageHeading("音乐库 / 扫描结果", "这次扫描没有完全成功", `${inspected.toLocaleString()} 个文件已检查，保留可读取内容。`)}
      <section className="partial-scan-page" aria-label="部分扫描失败">
        <div className="partial-scan-banner" role="status" aria-live="polite" aria-busy={checking}>
          <span className="partial-scan-icon"><RefreshCw className={checking ? "is-spinning" : ""} aria-hidden="true" /></span>
          <div className="partial-scan-copy"><span className="eyebrow">扫描结果</span><h2>{checking ? "正在重新检查文件" : "已载入可读取的音乐"}</h2><p>{checking ? "正在验证失败文件，请保持目录连接。" : `已读取 ${tracks.length.toLocaleString()} 首歌曲和 ${albums.length} 张专辑，另有 ${scanFailureCount} 个文件未能读取。`}</p></div>
          <div className="partial-scan-actions"><button type="button" className="button primary" onClick={() => retryLibrary("partial")} disabled={checking}>{checking && <LoaderCircle className="button-spinner" aria-hidden="true" />}{checking ? "正在扫描…" : "重新扫描"}</button><button type="button" className="button subtle" onClick={() => setModal({ type: "scan-failures" })}>查看失败详情</button></div>
        </div>
        <section className="partial-results"><div className="section-heading"><div><h2>已载入内容</h2><p>可读取的专辑和歌曲仍然可以播放、收藏和加入歌单。</p></div><span className="result-count">{albums.length} 张专辑 · {tracks.length.toLocaleString()} 首歌曲</span></div><div className="album-grid collection-grid">{albums.slice(0, 6).map(albumCard)}</div></section>
        <div className="partial-scan-note"><AlertTriangle aria-hidden="true" /><p>修复目录连接或文件权限后，再次扫描即可补齐缺失内容。</p><button type="button" className="text-button" onClick={() => setModal({ type: "scan-failures" })}>查看 {scanFailures.length} 个失败文件</button></div>
      </section>
    </>;
  }
  function renderCompleteScan() {
    return <>
      {pageHeading("音乐库 / 扫描结果", "曲库已经准备好", `${(data.scanJob?.scannedFiles ?? tracks.length).toLocaleString()} 个文件已完成扫描。`)}
      <section className="complete-scan-page" aria-label="扫描完成">
        <StatePanel className="complete-scan-state" icon={Check} eyebrow="扫描完成" title="音乐都准备好了" description={`已读取 ${tracks.length.toLocaleString()} 首歌曲和 ${albums.length} 张专辑，没有发现需要处理的文件。`} actions={[{ label: "浏览专辑", onClick: () => navigate("albums") }, { label: "回到首页", variant: "subtle", onClick: () => navigate("home") }]} />
        <div className="complete-scan-summary" aria-label="扫描统计">
          <div><span>歌曲</span><strong>{tracks.length.toLocaleString()}</strong><small>首可播放内容</small></div>
          <div><span>专辑</span><strong>{albums.length}</strong><small>张封面已载入</small></div>
          <div><span>失败文件</span><strong>0</strong><small>全部读取成功</small></div>
        </div>
      </section>
    </>;
  }
  function renderSetupEmpty() {
    if (!canManageLibrary) return renderLibraryEmpty("preview-empty-state");
    if (!initialSetup) return <>{pageHeading("音乐库 / 曲库", "曲库为空", "连接你的目录，让音乐慢慢归位。")}{renderLibraryEmpty("preview-empty-state")}</>;
    return <>
      {pageHeading("音乐库 / 初次设置", "先把音乐带进来", "选择音乐目录，开启你的私人音乐空间。")}
      <StatePanel className="preview-empty-state initial-setup-state" icon={FolderOpen} eyebrow="第一次使用" title="还没有连接音乐目录" description="选择一个本地或 NAS 挂载目录，开听会以只读方式扫描你的音乐。" actions={[{ label: "打开设置", onClick: () => { setDirectorySelection(""); setModal({ type: "settings" }); } }, { label: "回到首页", variant: "subtle", onClick: () => navigate("home") }]} />
    </>;
  }
  function renderScan() {
    if (!scanStartError && !data.scanJob && data.resources.summary.status !== "ready") return resourceUnavailable("summary");
    if (["complete", "partial", "empty"].includes(scan.status)) {
      if (!data.resources.tracks.hasValue) return resourceUnavailable("tracks");
      if (!data.resources.albums.hasValue) return resourceUnavailable("albums");
    }
    if (scan.status === "complete") return <>{resourceNotice("tracks")}{resourceNotice("albums")}{resourceNotice("summary")}{renderCompleteScan()}</>;
    if (scan.status === "partial") return <>{resourceNotice("tracks")}{resourceNotice("albums")}{renderPartialScan()}</>;
    if (scan.status === "idle") return <StatePanel icon={FolderOpen} title="从连接音乐目录开始" description="选择目录后，开听会自动扫描其中的音乐。" actions={[{ label: "选择目录", onClick: () => setModal({ type: "directory", returnTo: "settings" }) }]} />;
    if (scan.status === "empty") return <>{pageHeading("音乐库 / 扫描结果", "目录里还没有可播放的音乐", `已检查 ${scan.total} 个文件 · ${scan.path}`)}<StatePanel className="preview-empty-state" icon={FolderOpen} eyebrow="扫描完成 · 0 首歌曲" title="换一处，继续发现音乐" description="目录可能为空，或文件格式暂不支持。确认目录中包含音频文件，也可以选择另一个音乐目录。" actions={[{ label: "更换目录", onClick: () => setModal({ type: "directory", returnTo: "settings" }) }, { label: "重新扫描", variant: "subtle", onClick: () => startDirectoryScan(musicDirectory) }]} /></>;
    if (scan.status === "failed" || scan.status === "interrupted") return <>{pageHeading("音乐库 / 扫描", scan.status === "failed" ? "扫描还没有开始" : "这次扫描中断了", scan.path)}<StatePanel className="preview-empty-state" tone="error" icon={AlertTriangle} eyebrow={scan.status === "failed" ? "无法启动扫描" : `已检查 ${scan.processed.toLocaleString()} 个文件`} title={scan.status === "failed" ? "暂时无法启动扫描任务" : scan.reason === "stopped" ? "扫描已停止" : "音乐目录的连接断开了"} description={scan.status === "failed" ? `${scan.message || "扫描服务暂时没有响应。"} 已有曲库、收藏和歌单仍然保留，请稍后重试。` : scan.reason === "stopped" ? "已停止本次扫描，原曲库索引、收藏和歌单均保留。准备好后可以重新扫描。" : "本次扫描尚未完成，原曲库索引没有被删除。确认 NAS 挂载与网络连接后重新扫描。"} busy={scanStarting} actions={[{ label: scanStarting ? "正在启动…" : "重新扫描", busy: scanStarting, disabled: scanStarting, onClick: () => startDirectoryScan(scan.path) }, { label: "检查目录", variant: "subtle", onClick: () => setModal({ type: "settings" }) }]} /></>;
    const percentage = scan.total ? Math.round(scan.processed / Math.max(1, scan.total) * 100) : 0;
    return <>{pageHeading("音乐库 / 扫描中", "让音乐，慢慢归位", "可以继续浏览音乐室，扫描会在后台继续。")}
      <section className="scan-progress-page" aria-label="音乐目录扫描进度">
        <span className="scan-orbit"><Disc3 /><LoaderCircle className="button-spinner" /></span>
        <span className="eyebrow">{percentage < 25 ? "发现音乐文件" : percentage < 85 ? "读取歌曲与专辑信息" : "整理封面与曲库索引"}</span><h2>正在扫描你的音乐</h2>
        <p className="scan-path">{scan.path}</p><div className="scan-progress-track" role="progressbar" aria-label="扫描进度" aria-valuemin={0} aria-valuemax={scan.total} aria-valuenow={scan.processed}><span style={{ width: `${percentage}%` }} /></div>
        <div className="scan-progress-count"><span>{scan.processed.toLocaleString()} / {scan.total.toLocaleString()} 个文件</span><strong>{percentage}%</strong></div>
        <p className="muted-copy" role={data.scanError ? "alert" : undefined}>{data.scanError ? `${data.scanError} 正在尝试重新读取进度。` : `${scan.message || "正在发现音乐文件"} · 仅扫描，不改动原文件`}</p>
        <div className="state-actions"><button className="button subtle" onClick={() => navigate("home")}>继续浏览</button><button className="text-button" onClick={() => { void api.stopScan().then(data.setScanJob).catch((reason) => announce(reason.message)); }}>停止扫描</button></div>
      </section></>;
  }
  function renderPage() {
    if (section === "account") return renderAccount(routeId === "security" ? "security" : routeId === "permissions" ? "denied" : "profile");
    if (section === "admin") return routeId === "users" ? renderAccount("users") : renderNotFound();
    if (!canManageLibrary && ["scan", "setup", "directory-unavailable"].includes(section)) return renderAccount("denied");
    if (section === "scan") return renderScan();
    if (data.status === "loading") return <>{pageHeading("音乐库", "正在载入你的音乐", "留一点时间，给喜欢的声音。")}<ContentSkeleton detail={section === "album"} /></>;
    if (data.status === "error") return renderLibraryError();
    if (scan.status === "running" && !tracks.length && ["home", "albums", "songs", "artists", "album", "artist"].includes(section)) return renderLibraryLoading();
    if (searching) return renderSearch();
    if (directoryUnavailable && ["home", "albums", "songs", "artists"].includes(section)) return renderDirectoryUnavailable();
    const required: Partial<Record<string, RoomResource>> = { songs: "tracks", favorites: "tracks", albums: "albums", album: "albums", playlists: "playlists", playlist: "playlists" };
    const resource = required[section];
    if (resource && !data.resources[resource].hasValue) return resourceUnavailable(resource, section === "album");
    if (libraryMode !== "ready" && data.resources.tracks.status === "ready" && data.resources.albums.status === "ready" && ["home", "albums", "songs", "artists", "album", "artist"].includes(section)) return initialSetup ? renderSetupEmpty() : renderLibraryEmpty("preview-empty-state");
    if (section === "setup") return renderSetupEmpty();
    if (section === "home") return renderHome();
    if (section === "albums") return <>{resourceNotice("albums")}{renderAlbums()}</>;
    if (section === "album") {
      const key = decodeRouteId(routeId);
      const album = albums.find((item) => item.id === key);
      if (!album) {
        if (data.resources.albums.status !== "ready") return resourceUnavailable("albums", true);
        if (albumLookupError) return <StatePanel tone="error" icon={AlertTriangle} title="这张专辑暂时没有载入" description={albumLookupError} actions={[{ label: "重新载入专辑", onClick: () => { setAlbumLookupError(""); setAlbumLookupAttempt((value) => value + 1); } }, { label: "回到唱片架", variant: "subtle", onClick: () => navigate("albums") }]} />;
        if (missingAlbumKey !== key) return <ContentSkeleton detail />;
      }
      return <>{resourceNotice("albums")}{renderAlbum(album)}</>;
    }
    if (section === "artists") return renderArtists();
    if (section === "artist") return renderArtist(routeId);
    if (section === "playlist") return <>{resourceNotice("playlists")}{renderPlaylist(playlists.find((item) => item.id === routeId))}</>;
    if (section === "playlists") return <>{resourceNotice("playlists")}{renderPlaylists()}</>;
    if (section === "favorites") return <>{resourceNotice("tracks")}{renderFavorites()}</>;
    if (section === "songs") return <>{resourceNotice("tracks")}{renderSongs()}</>;
    if (section === "loading") return renderLibraryLoading();
    if (section === "error") return renderLibraryError();
    if (section === "directory-unavailable") return renderDirectoryUnavailable();
    return renderNotFound();
  }
  function queueContent() {
    if (!hasCurrent) return <StatePanel icon={ListMusic} title="这里还很安静" description="挑选一首歌曲，开始今天的聆听。" actions={[{ label: "浏览歌曲", onClick: () => { setQueueOpen(false); navigate("songs"); } }]} />;
    return <div className="queue-content"><div className="queue-current"><span className="eyebrow">正在播放</span><div><Cover album={currentAlbum} /><span><strong>{displayTitle(current)}</strong><small>{current.artist}</small></span><span className={`equalizer ${isPlaying ? "is-playing" : "is-paused"}`} aria-hidden="true"><i /><i /><i /></span></div></div><div className="queue-section-label"><span>待播清单 <small>{queue.length} 首</small></span><button onClick={() => { setQueue([current]); announce("已清空其他待播歌曲"); }} disabled={queue.length <= 1}>清空</button></div><div className="queue-tracks">{queue.map((track, index) => <div className={`queue-row ${track.id === currentId ? "current" : ""}`} key={track.id}><button className="queue-track-select" onClick={() => play(track)}><span className="queue-number">{track.id === currentId ? <span className={`equalizer ${isPlaying ? "is-playing" : "is-paused"}`} aria-hidden="true"><i /><i /><i /></span> : String(index + 1).padStart(2, "0")}</span><Cover album={(albumMap.get(track.albumId) ?? emptyAlbum)} /><span><strong>{displayTitle(track)}</strong><small>{track.artist}</small></span></button><div className="queue-row-actions"><IconButton label={`上移 ${displayTitle(track)}`} disabled={index === 0} onClick={() => moveQueue(index, -1)}><ArrowUp /></IconButton><IconButton label={`下移 ${displayTitle(track)}`} disabled={index === queue.length - 1} onClick={() => moveQueue(index, 1)}><ArrowDown /></IconButton>{track.id !== currentId && <IconButton label={`移除 ${displayTitle(track)}`} onClick={() => setQueue((items) => items.filter((item) => item.id !== track.id))}><X /></IconButton>}</div></div>)}</div></div>;
  }

  return <LibraryContext.Provider value={{ albumMap, trackMap }}><div className={`app ${isMobile ? "mobile-layout" : "desktop-layout"} ${dense ? "dense-layout" : ""} ${darkMode ? "dark-theme" : ""} library-surface ${homePage ? "home-surface" : ""} ${catalogPage ? "catalog-surface" : ""}`}>
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }}>跳到主要内容</a>
    <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`} aria-label="音乐库导航" inert={isMobile && !mobileNavOpen}>
      <button className="brand" aria-label="开听首页" onClick={() => navigate("home")}><span className="brand-mark" aria-hidden="true"><BrandGlyph /></span><span>开听</span></button>
      {isMobile && <IconButton className="close-mobile-nav" label="关闭导航" onClick={() => setMobileNavOpen(false)}><X /></IconButton>}
      <div className="sidebar-content">
        <span className="nav-label">我的音乐</span><nav className="main-nav">{navItems.map(({ route: target, title, icon: Icon }) => <button key={target} aria-label={title} aria-current={!searching && (section === target || section === target.replace(/s$/, "")) ? "page" : undefined} onClick={() => navigate(target)}><Icon /><span>{title}</span>{target === "favorites" && <small>{data.resources.tracks.hasValue ? favorites.size : "—"}</small>}</button>)}<button className="compact-playlists" aria-label="我的歌单" aria-current={!searching && (section === "playlists" || section === "playlist") ? "page" : undefined} onClick={() => navigate("playlists")}><ListMusic /><span>我的歌单</span></button></nav>
        <div className="playlist-nav-heading"><button className="nav-label" onClick={() => navigate("playlists")}>我的歌单</button><IconButton label="新建歌单" onClick={() => { setNewPlaylistName(""); setPlaylistError(""); setModal({ type: "create" }); }}><Plus /></IconButton></div>
        {data.resources.playlists.status === "error" && <button className="sidebar-resource-retry" onClick={() => { void data.refresh("playlists").catch(() => undefined); }}>歌单暂未载入 · 重试</button>}
        <nav className="playlist-nav">{playlists.map((playlist) => <button key={playlist.id} aria-current={routeId === playlist.id ? "page" : undefined} onClick={() => navigate(`playlist/${playlist.id}`)}><div className="sidebar-playlist-art" aria-hidden="true"><PlaylistArt playlist={playlist} /></div><ListMusic /><span>{playlist.name}</span></button>)}</nav>
      </div>
      <div className="sidebar-bottom"><div className="local-library"><span className="status-dot" /><div><strong>本地音乐库</strong><span>{data.resources.tracks.hasValue ? `${tracks.length.toLocaleString()} 首` : "歌曲待载入"} · {data.resources.albums.hasValue ? `${albums.length} 张专辑` : "专辑待载入"}</span></div><Disc3 /></div><button className="settings-button login-entry" aria-label={authenticated ? "我的账号" : "登录私人音乐空间"} aria-current={section === "account" || section === "admin" ? "page" : undefined} onClick={() => { if (authenticated) navigate("account"); else { loginReturn.current = pageRoute; navigate("login"); } }}><UserRound /> {authenticated ? "我的账号" : "登录"} <ChevronRight /></button><button className="settings-button" aria-label="音乐室设置" onClick={() => setModal({ type: "settings" })}><Settings2 /> 设置 <ChevronRight /></button></div>
    </aside>
    {isMobile && mobileNavOpen && <button className="nav-backdrop" aria-label="收起导航" onClick={() => setMobileNavOpen(false)} />}
    <div className="workspace" style={{ "--content-scrollbar-width": `${contentScrollbarWidth}px` } as CSSProperties}>
      <header className="topbar">
        {isMobile && <div className="breadcrumbs"><IconButton label="打开导航" onClick={() => setMobileNavOpen(true)}><Library /></IconButton></div>}
        <div className="search-control"><label className="search-field"><Search /><input ref={searchRef} value={query} placeholder="找一首歌、一张专辑、一位艺人" aria-label="搜索歌曲、专辑、艺人" onFocus={() => { setSearchFocused(true); if (searchCommitted) setSearchCommitted(false); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitSearch(); } }} onChange={(event) => { setQuery(event.target.value); setSearchCommitted(false); setSearchFocused(true); setPageLimit(40); }} />{query && <button aria-label="清空搜索" onMouseDown={(event) => event.preventDefault()} onClick={() => clearSearch(true)}><X /></button>}</label>{renderSearchSuggestions()}</div>
      </header>
      <main ref={mainRef} id="main-content" data-route={pageRoute} className="main-content" tabIndex={-1}><div className="page-content" key={searching ? "search" : pageRoute}>{renderPage()}</div></main>
    </div>
    <div className="global-feedback-stack">
      {canManageLibrary && ["running", "partial", "failed", "interrupted"].includes(scan.status) && section !== "scan" && !(section === "preview" && routeId?.startsWith("scan-")) && <button className="scan-status-link" onClick={() => navigate("scan")}>{scan.status === "running" ? <LoaderCircle className="button-spinner" /> : <Disc3 />}<span>{scan.status === "running" ? `正在扫描 · ${Math.round(scan.processed / Math.max(1, scan.total) * 100)}%` : "扫描需要处理"}</span><span>查看{scan.status === "running" ? "进度" : "结果"}</span><ChevronRight /></button>}
      {!modal && route !== "playing" && renderWriteFeedback(true)}
      {hasCurrent && route !== "playing" && <PlaybackFeedback compact isMobile={isMobile} phase={phase} onRetry={retryPlayback} onNext={() => nextTrack()} />}
    </div>
    {hasCurrent ? <CapsulePlayer
      trackId={currentId} phase={phase} title={current.title} artist={current.artist} album={currentAlbum.title} cover={currentAlbum.cover}
      isMobile={isMobile} playing={isPlaying} position={position} duration={player.duration || current.duration}
      volume={volume} shuffle={shuffle} repeat={repeat} queueOpen={queueOpen}
      onTogglePlay={togglePlay} onPrevious={previousTrack} onNext={() => nextTrack()}
      onToggleShuffle={() => setShuffle((value) => !value)}
      onToggleRepeat={() => setRepeat((value) => ((value + 1) % 3) as 0 | 1 | 2)}
      onSeek={player.seek} onVolumeChange={setVolume} onOpenPlayer={openPlayer}
      onOpenQueue={() => setQueueOpen(true)}
      onOpenArtist={() => navigate(`artist/${encodeURIComponent(current.artist)}`)}
      onOpenAlbum={() => navigate(`album/${encodeURIComponent(currentAlbum.id)}`)}
    /> : <footer className="capsule-player empty-player" aria-label="尚未开始播放"><span className="empty-player-art"><Music2 /></span><span><strong>挑一首，让音乐开始</strong><small>{initialSetup ? "先连接你的音乐目录" : "你的下一段旋律，在这里等你"}</small></span><button onClick={() => initialSetup ? setModal({ type: "settings" }) : navigate("songs")}>{initialSetup ? "连接目录" : "浏览歌曲"}</button></footer>}
    {queueOpen && <Modal className="queue-dialog" label="待播清单" onClose={() => setQueueOpen(false)}><div className="dialog-heading"><div><span className="eyebrow">KEEP THE MUSIC GOING</span><h2>接下来听</h2></div><IconButton label="关闭待播清单" onClick={() => setQueueOpen(false)}><X /></IconButton></div>{queueContent()}</Modal>}
    {hasCurrent && (route === "playing" || (section === "preview" && (routeId?.startsWith("lyrics-") || routeId === "queue-empty"))) && <Modal key={route === "playing" ? "player" : routeId} className="now-playing-dialog" label="沉浸播放器" onClose={closePlayer}>
      {renderWriteFeedback(true)}
      <NowPlaying
        phase={phase} onRetry={retryPlayback}
        track={{ ...current, duration: player.duration || current.duration, title: displayTitle(current), cover: currentAlbum.cover }} album={currentAlbum}
        queue={queue.map((track) => ({ ...track, title: displayTitle(track), cover: (albumMap.get(track.albumId)?.cover ?? "") }))}
        isMobile={isMobile} playing={isPlaying} position={position} readPosition={player.readPosition} volume={volume}
        favorite={favorites.has(currentId)} shuffle={shuffle} repeat={repeat}
        onClose={closePlayer} onTogglePlay={togglePlay} onPrevious={previousTrack} onNext={() => nextTrack()}
        onSeek={player.seek} onVolumeChange={setVolume} onToggleFavorite={() => toggleFavorite(currentId)}
        onToggleShuffle={() => setShuffle((value) => !value)}
        onToggleRepeat={() => setRepeat((value) => ((value + 1) % 3) as 0 | 1 | 2)}
        onOpenAlbum={() => navigate(`album/${encodeURIComponent(currentAlbum.id)}`)}
        onOpenArtist={() => navigate(`artist/${encodeURIComponent(current.artist)}`)}
        onSelectTrack={(id) => play(trackMap.get(id)!)} onMoveTrack={moveQueue}
        onRemoveTrack={(id) => setQueue((items) => items.filter((item) => item.id !== id))}
        onClearQueue={() => setQueue([current])}
      />
    </Modal>}
    {modal && <Modal key={modal.type} className={`standard-dialog${modal.type === "album-metadata" ? " album-metadata-dialog" : ""}`} label={modal.type === "album-metadata" ? "编辑专辑信息" : modal.type === "rename" ? "重命名歌单" : modal.type === "delete" ? "删除歌单" : modal.type === "create" ? "新建歌单" : modal.type === "add" ? "添加到歌单" : modal.type === "playlist-add" ? "添加歌曲" : modal.type === "settings" ? "音乐室设置" : modal.type === "directory" ? "选择音乐目录" : modal.type === "scan-failures" ? "扫描失败详情" : "关于开听"} onClose={closeDialog}><div className="dialog-heading"><span className="dialog-symbol">{modal.type === "create" || modal.type === "add" || modal.type === "playlist-add" ? <ListMusic /> : modal.type === "settings" ? <Settings2 /> : modal.type === "directory" ? <FolderOpen /> : modal.type === "scan-failures" ? <AlertTriangle /> : <Disc3 />}</span><IconButton label="关闭对话框" onClick={closeDialog}><X /></IconButton></div><fieldset className="dialog-body" disabled={writeState === "saving" || scanStarting}>

      {modal.type === "album-metadata" && <AlbumMetadataForm albumId={modal.albumId} onClose={closeDialog} onBusyChange={setMetadataSaving} onSaved={(metadata) => { data.updateAlbum(metadata.album); void data.refresh("tracks"); void data.refresh("albums"); setModal(null); announce("专辑信息已保存"); }} />}
      {modal.type === "rename" && <form onSubmit={(event) => { event.preventDefault(); const name = newPlaylistName.trim(); if (!name) { setPlaylistError("给歌单起一个名字吧"); return; } saveChange("重命名歌单", async () => { await api.renamePlaylist(modal.playlistId, name); const detail = mapPlaylist(await api.playlist(modal.playlistId)); setPlaylists((items) => items.map((item) => item.id === detail.id ? detail : item)); setModal(null); }); }}><h2>给歌单，一个新名字</h2><p>歌曲与排列顺序都会保留。</p><label className="form-field">歌单名称<input value={newPlaylistName} maxLength={60} aria-invalid={Boolean(playlistError)} aria-describedby={playlistError ? "rename-error" : undefined} onChange={(event) => { setNewPlaylistName(event.target.value); setPlaylistError(""); }} /></label>{playlistError && <p className="form-error" id="rename-error" role="alert">{playlistError}</p>}<div className="dialog-actions"><button type="button" className="button subtle" onClick={closeDialog}>取消</button><button className="button primary" type="submit">保存名称</button></div></form>}
      {modal.type === "delete" && <><h2>删除这张歌单？</h2><p>「{playlists.find((item) => item.id === modal.playlistId)?.name}」会从私人歌单中移除。曲库中的音乐文件和收藏不会被删除。</p><div className="dialog-actions"><button className="button subtle" onClick={closeDialog}>保留歌单</button><button className="button danger" onClick={() => saveChange("删除歌单", async () => { await api.deletePlaylist(modal.playlistId); setPlaylists((items) => items.filter((item) => item.id !== modal.playlistId)); setOrderDraft(null); setModal(null); navigate("playlists"); })}><Trash2 />删除歌单</button></div></>}
      {modal.type === "create" && <form onSubmit={(event) => { event.preventDefault(); createPlaylist(); }}><h2>给心情，一张歌单</h2><p>装下某个时刻，也收藏某种喜欢。</p><label className="form-field">歌单名称<input autoFocus value={newPlaylistName} maxLength={60} placeholder="比如：星期天的午后" aria-invalid={Boolean(playlistError)} aria-describedby={playlistError ? "playlist-error" : undefined} onChange={(event) => { setNewPlaylistName(event.target.value); setPlaylistError(""); }} /></label>{playlistError && <p className="form-error" id="playlist-error" role="alert">{playlistError}</p>}<div className="dialog-actions"><button type="button" className="button subtle" onClick={() => setModal(null)}>再想想</button><button type="submit" className="button primary"><Plus /> 创建歌单</button></div></form>}
      {modal.type === "add" && <><h2>收藏到哪张歌单？</h2><p>{displayTitle(trackMap.get(modal.trackId)!)}</p>{resourceNotice("playlists")}<div className="add-playlist-list">{playlists.map((playlist) => <button key={playlist.id} disabled={Boolean(playlist.detailError)} onClick={() => addToPlaylist(playlist.id, modal.trackId)}><PlaylistArt playlist={playlist} /><span><strong>{playlist.name}</strong><small>{playlist.detailError ? "内容暂未载入，请在我的歌单中重试" : `${playlist.trackIds.length} 首歌曲`}</small></span>{playlist.trackIds.includes(modal.trackId) ? <Check /> : <Plus />}</button>)}</div>{!playlists.length && data.resources.playlists.status === "ready" && <p className="muted-copy">还没有歌单，先为这些旋律建一张吧。</p>}<button className="button subtle full-width" onClick={() => { setNewPlaylistName(""); setPlaylistError(""); setModal({ type: "create", trackId: modal.trackId }); }}><Plus /> 创建新歌单</button></>}
      {modal.type === "playlist-add" && (() => {
        const playlist = playlists.find((item) => item.id === modal.playlistId);
        if (!playlist) return null;
        const term = playlistTrackQuery.trim().toLocaleLowerCase();
        const available = tracks.filter((track) => !playlist.trackIds.includes(track.id) && `${displayTitle(track)} ${track.artist} ${albumMap.get(track.albumId)?.name ?? ""}`.toLocaleLowerCase().includes(term)).slice(0, 60);
        return <><h2>添加歌曲</h2><p>从曲库挑选歌曲，加入「{playlist.name}」。</p><label className="form-field playlist-track-search">搜索歌曲<input autoFocus value={playlistTrackQuery} placeholder="输入歌曲、艺人或专辑" aria-label="搜索要添加的歌曲" onChange={(event) => setPlaylistTrackQuery(event.target.value)} /></label><div className="add-playlist-list track-picker-list">{available.map((track) => <button key={track.id} onClick={() => addToPlaylist(playlist.id, track.id)}><Cover className="playlist-track-cover" album={(albumMap.get(track.albumId) ?? emptyAlbum)} /><span><strong>{displayTitle(track)}</strong><small>{track.artist} · {albumMap.get(track.albumId)?.name}</small></span><Plus /></button>)}{!available.length && <div className="picker-empty"><Music2 /><span>{!tracks.length ? "曲库还没有歌曲，先连接音乐目录吧。" : term ? "没有匹配的未添加歌曲" : "这个歌单已经收下曲库里的歌曲了"}</span></div>}</div></>;
      })()}
      {modal.type === "info" && <><span className="eyebrow">MUSIC LIBRARY · PRIVATE SPACE</span><h2>属于你的，私人音乐空间</h2><p>以唱片收藏为灵感，让浏览、发现与聆听都慢下来。</p><div className="about-stats"><span><strong>{tracks.length.toLocaleString()}</strong>首歌曲</span><span><strong>{albums.length}</strong>张真实专辑</span><span><strong>01</strong>私人音乐室</span></div><div className="prototype-explanation"><Info /><p>开听以只读方式连接你的音乐目录。收藏、歌单与账号信息保存在音乐室中，音乐文件始终保持原样。</p></div><button className="button primary full-width" onClick={() => setModal(null)}>开始逛逛 <ArrowRight /></button></>}
      {modal.type === "directory" && <>
        <h2>选择音乐目录</h2>
        <p>选择一个本地或 NAS 挂载目录，开听会以只读方式扫描其中的音乐文件。</p>
        {directoryError && <p className="form-error" role="alert">{directoryError} 可以双击目录重试。</p>}
        <div className="directory-picker" role="listbox" aria-label="可用音乐目录">
          <div className="directory-picker-heading"><span>可用目录</span><span>只读</span></div>
          {directoryOptions.map((option) => <button type="button" role="option" aria-selected={directorySelection === option.path} aria-disabled={!option.available} className={`directory-option ${directorySelection === option.path ? "is-selected" : ""} ${!option.available ? "is-unavailable" : ""}`} key={option.path} disabled={!option.available} onClick={() => setDirectorySelection(option.path)} onDoubleClick={() => { if (option.available) void browseDirectory(option.path); }}><span className="directory-option-icon"><FolderOpen aria-hidden="true" /></span><span><strong>{option.path}</strong><small>{option.detail}</small></span>{directorySelection === option.path && <Check aria-hidden="true" />}</button>)}
        </div>
        <div className="prototype-explanation"><Info /><p>选择服务器上的音乐目录。双击可读目录可查看其子目录；只显示部署时允许访问的位置。</p></div>
        <div className="dialog-actions"><button type="button" className="button subtle" onClick={() => setModal(modal.returnTo === "settings" ? { type: "settings" } : null)}>取消</button><button type="button" className="button primary" disabled={!directoryOptions.find((option) => option.path === directorySelection)?.available} onClick={() => startDirectoryScan(directorySelection)}>{scanStarting ? "正在连接…" : "选择此目录"}</button></div>
      </>}
      {modal.type === "scan-failures" && <>
        <h2>扫描失败详情</h2>
        <p>共 {scanFailureCount} 个文件需要处理。{scanFailureCount > scanFailures.length ? `当前显示前 ${scanFailures.length} 条记录。` : ""}修复目录连接或权限后，可以重新扫描。</p>
        <div className="scan-failure-list" role="list" aria-label="扫描失败文件">
          {scanFailures.map((failure) => <div className="scan-failure-row" role="listitem" key={failure.path}><span className="scan-failure-icon"><AlertTriangle aria-hidden="true" /></span><span><strong>{failure.path}</strong><small>{failure.reason} · {failure.hint}</small></span></div>)}
        </div>
        <div className="dialog-actions"><button type="button" className="button subtle" onClick={() => setModal(null)}>返回扫描结果</button><button type="button" className="button primary" onClick={() => { setModal(null); retryLibrary("partial"); }}>重新扫描</button></div>
      </>}
      {modal.type === "settings" && <>
        <h2>音乐室设置</h2>
        <p>把这里调成你喜欢的样子。</p>
        <div className="settings-account-summary">{accountUser ? <><AccountAvatar user={accountUser} /><span><strong>{accountUser.displayName}</strong><small>{roleLabel(accountUser.role)} · @{accountUser.username}</small></span><button className="text-button" onClick={() => { setModal(null); navigate("account"); }}>账号设置<ChevronRight /></button></> : <><UserRound /><span><strong>正在体验音乐室</strong><small>登录后管理你的账号与私人收藏</small></span><button className="text-button" onClick={() => { setModal(null); loginReturn.current = "account"; navigate("login"); }}>登录<ChevronRight /></button></>}</div>
        {canManageLibrary ? <div className="directory-setting" aria-labelledby="music-directory-heading">
          <div className="directory-setting-heading"><span><strong id="music-directory-heading">音乐目录</strong><small>只读扫描本地或 NAS 挂载的音乐文件</small></span><span className={`setting-badge ${initialSetup ? "is-pending" : ""}`}>{initialSetup ? "未设置" : scan.status === "running" ? "扫描中" : directoryUnavailable ? "不可访问" : "已连接"}</span></div>
          <div className="directory-card"><span className="directory-icon"><FolderOpen /></span><span className="directory-copy"><strong>{initialSetup ? "尚未选择目录" : musicDirectory}</strong><small>{initialSetup ? "选择目录后会自动开始扫描" : scan.status === "running" ? "正在读取歌曲、专辑和封面" : "只读访问 · 音乐文件保持原样"}</small></span><button className="directory-action" disabled={scan.status === "running"} onClick={() => { setDirectorySelection(initialSetup ? "" : musicDirectory); setModal({ type: "directory", returnTo: "settings" }); }}>{initialSetup ? "选择目录" : "更换"}</button></div>
          <div className="directory-meta"><span><Disc3 />{initialSetup ? "等待连接目录" : scan.status === "running" ? `${scan.processed.toLocaleString()} / ${scan.total.toLocaleString()} 个文件` : `${tracks.length.toLocaleString()} 首歌曲 · ${albums.length} 张专辑`}</span><button className="directory-scan" onClick={() => initialSetup ? (setDirectorySelection(""), setModal({ type: "directory", returnTo: "settings" })) : scan.status === "running" ? (setModal(null), navigate("scan")) : startDirectoryScan(musicDirectory)}>{scan.status === "running" ? "查看进度" : initialSetup ? "选择目录" : "重新扫描"}</button></div>
          {scan.status !== "idle" && scan.status !== "running" && <button className="settings-scan-result" onClick={() => { setModal(null); navigate("scan"); }}>{scan.status === "complete" ? "上次扫描已全部完成" : scan.status === "empty" ? "上次扫描未发现音乐" : scan.status === "partial" ? `上次扫描有 ${scanFailureCount} 个文件需要处理` : "上次扫描未完成"}<span>查看结果 <ChevronRight /></span></button>}
        </div>
        : <div className="directory-setting"><div className="directory-setting-heading"><span><strong>共享音乐库</strong><small>音乐目录与扫描由管理员维护，你可以自由浏览和聆听。</small></span><span className="setting-badge">只读聆听</span></div></div>}
        {resourceNotice("directory")}{resourceNotice("summary")}
        <div className="setting-row"><span><strong>紧凑歌曲列表</strong><small>在同一屏里看见更多音乐</small></span><button className={`toggle ${dense ? "on" : ""}`} role="switch" aria-checked={dense} aria-label="紧凑歌曲列表" onClick={() => setDense((value) => !value)}><span /></button></div>
        <div className="setting-row"><span><strong>深色主题</strong><small>降低环境光下的亮度，保留红色强调</small></span><button className={`toggle ${darkMode ? "on" : ""}`} role="switch" aria-checked={darkMode} aria-label="深色主题" onClick={() => setDarkMode((value) => !value)}><span /></button></div>
        <div className="setting-row"><span><strong>曲库快照</strong><small>{directoryUnavailable ? "目录恢复后才能读取快照" : initialSetup ? "选择目录并完成扫描后生成" : scan.status === "running" && libraryMode !== "ready" ? "正在准备首份曲库快照" : libraryDirectoryNeedsScan ? "等待目录扫描后建立快照" : partialScan ? `已载入 ${tracks.length.toLocaleString()} 首歌曲 · 仍有 ${scanFailureCount} 个文件失败` : `${tracks.length.toLocaleString()} 首歌曲 · ${albums.length} 张专辑`}</small></span><span className={`setting-badge ${directoryUnavailable ? "is-error" : initialSetup || libraryDirectoryNeedsScan || partialScan ? "is-pending" : ""}`}>{directoryUnavailable ? "不可用" : initialSetup ? "未生成" : scan.status === "running" && libraryMode !== "ready" ? "生成中" : libraryDirectoryNeedsScan ? "待生成" : partialScan ? "部分" : "已载入"}</span></div>

        <div className="prototype-explanation"><Info /><p>音乐目录以只读方式连接。收藏、歌单和账号设置保存在音乐室的数据目录，所有更改不会修改原始音乐文件。</p></div>
        <button className="button primary full-width" onClick={() => setModal(null)}>就这样，很好</button>
      </>}
    </fieldset>{renderWriteFeedback()}</Modal>}
    {menu && <><button className="menu-backdrop" aria-label="关闭歌曲操作菜单" onClick={() => setMenu(null)} /><div className="track-menu" role="menu" aria-label="歌曲操作" style={{ left: Math.max(12, menu.x), top: Math.max(12, menu.y) }}><button role="menuitem" autoFocus onClick={() => enqueue(menu.track, true)}><SkipForward /> 下一首播放</button><button role="menuitem" onClick={() => enqueue(menu.track)}><ListMusic /> 加入待播清单</button><button role="menuitem" onClick={() => { setModal({ type: "add", trackId: menu.track.id }); setMenu(null); }}><Plus /> 添加到歌单</button><button role="menuitem" onClick={() => { toggleFavorite(menu.track.id); setMenu(null); }}><Heart />{favorites.has(menu.track.id) ? "取消收藏" : "收藏歌曲"}</button><button role="menuitem" onClick={() => navigate(`album/${encodeURIComponent(menu.track.albumId)}`)}><Disc3 /> 前往专辑</button></div></>}
    <div className={`toast ${toast ? "visible" : ""}`} role="status" aria-live="polite">{toast && <><Check size={16} />{toast}</>}</div>
  </div></LibraryContext.Provider>;
}
