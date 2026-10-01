import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, ChevronLeft,
  ChevronRight, Clock3, Disc3, FolderOpen, Headphones, Heart, House, Info, Library,
  ListMusic, LoaderCircle, MoreHorizontal, Music2, Pause, Play, Plus,
  RefreshCw, Search, Settings2, Shuffle, SkipForward, UserRound, Pencil, Trash2,
  X, type LucideIcon
} from "lucide-react";
import library from "./library.json";
import { CapsulePlayer } from "./CapsulePlayer";
import { NowPlaying } from "./NowPlaying";
import { usePrototypeAudio } from "./usePrototypeAudio";
import { PlaylistOrderEditor } from "./PlaylistOrderEditor";
import { LoginScreen } from "./LoginScreen";
import { AccountAvatar, AccountPages } from "./AccountPages";
import { initialAccounts, initialSessions, roleLabel, type AccountSession, type AccountUser } from "./account-state";
import { Artwork, ContentSkeleton, PlaybackFeedback } from "./StateComponents";
import { advanceScan, beginScan, idleScan, playbackBusy, previewGroups, readable, trackTime, yearLabel, type PlaybackPhase, type ScanOutcome, type ScanState } from "./prototype-state";
import { useMobileLayout } from "../../../src/client/mobile-layout";

type Album = (typeof library.albums)[number];
type Track = (typeof library.tracks)[number] & { lossless: boolean };
type Playlist = { id: string; name: string; description: string; trackIds: string[] };
type ModalState = { type: "create"; trackId?: string } | { type: "add"; trackId: string } | { type: "playlist-add"; playlistId: string } | { type: "info" } | { type: "settings" } | { type: "directory"; returnTo?: "settings" | "directory-unavailable" } | { type: "scan-failures" } | { type: "rename" | "delete"; playlistId: string } | null;
type StateAction = { label: string; onClick: () => void; variant?: "primary" | "subtle"; disabled?: boolean; busy?: boolean };
type CheckKind = "service" | "directory" | "partial";
type CheckStatus = "idle" | "checking" | "failed" | "complete";
const albums = library.albums.map((album) => ({ ...album, name: readable(album.name, "未命名专辑"), title: readable(album.title, "未命名专辑"), artist: readable(album.artist, "未知艺人"), genre: readable(album.genre, "未分类") }));
const tracks = library.tracks.map((track) => ({ ...track, title: readable(track.title, "未命名歌曲"), artist: readable(track.artist, "未知艺人"), lossless: ["ALAC", "FLAC"].includes(track.format.toUpperCase()) }));
const sourceAlbums = albums;
const sourceTracks = tracks;
const albumMap = new Map(albums.map((album) => [album.id, album]));
const trackMap = new Map(tracks.map((track) => [track.id, track]));
const albumTracks = (id: string) => tracks.filter((track) => track.albumId === id);
const displayTitle = (track: Track) => track.title.split(" ／ ")[0].replace(/ \(FF7 Rebirth OST Ver\.\)/g, "");
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const durationLabel = (seconds: number) => seconds >= 3600 ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟` : `${Math.ceil(seconds / 60)} 分钟`;
const featured = albums[0];
const initialQueue = [...albumTracks("album-5"), ...albumTracks("album-1").slice(0, 6)];
const startingFavorites = new Set([initialQueue[0].id, ...albums.map((album) => albumTracks(album.id)[1]?.id).filter(Boolean)]);
const starterPlaylists: Playlist[] = [
  { id: "quiet", name: "把时间放慢", description: "给自己一段不被打扰的时间。", trackIds: [0, 1, 3, 4, 6, 8].flatMap((n) => albumTracks(albums[n].id).slice(0, 2).map((track) => track.id)) },
  { id: "journey", name: "冒险仍在继续", description: "重回那些舍不得离开的世界。", trackIds: [2, 0, 6, 7].flatMap((n) => albumTracks(albums[n].id).slice(0, 4).map((track) => track.id)) },
  { id: "night", name: "深夜的耳机", description: "城市睡着以后，旋律还醒着。", trackIds: [4, 3, 1].flatMap((n) => albumTracks(albums[n].id).slice(2, 5).map((track) => track.id)) }
];
const directoryOptions = [
  { path: "/music", detail: "NAS 挂载 · 可读", available: true },
  { path: "/music/Albums", detail: "子目录 · 可读", available: true },
  { path: "/Volumes/Music", detail: "本机目录 · 未连接", available: false }
];
const scanFailures = [
  { path: "OST/Octopath Traveler II/Disc 03/track-07.m4a", reason: "NAS 返回权限不足", hint: "检查目录访问权限后重新扫描" },
  { path: "Game Music/Final Fantasy VII/bonus.flac", reason: "文件内容不完整", hint: "重新复制文件或跳过此文件" },
  { path: "Albums/Xenoblade 2/cover.jpg", reason: "封面读取超时", hint: "确认 NAS 连接稳定后重试" }
];
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

function PlaylistArt({ playlist }: { playlist: Playlist }) {
  const covers = [...new Set(playlist.trackIds.map((id) => trackMap.get(id)?.albumId))]
    .map((id) => id ? albumMap.get(id) : undefined)
    .filter((album): album is Album => Boolean(album))
    .slice(0, 4);
  return <div className="playlist-art" data-cover-count={covers.length} role="img" aria-label={`${playlist.name}的歌单封面${covers.length ? "" : "，暂无歌曲"}`}>
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

export function App() {
  const isMobile = useMobileLayout();
  const [route, setRoute] = useState(readRoute);
  const backgroundRoute = useRef("home");
  const previousPage = useRef(route === "playing" ? "home" : route);
  const [query, setQuery] = useState(readSearchQuery);
  const [searchCommitted, setSearchCommitted] = useState(() => Boolean(readSearchQuery()));
  const [searchFocused, setSearchFocused] = useState(false);
  const [albumDiscFilter, setAlbumDiscFilter] = useState("全部");
  const [formatFilter, setFormatFilter] = useState("全部");
  const [favorites, setFavorites] = useState(startingFavorites);
  const [playlists, setPlaylists] = useState(starterPlaylists);
  const [queue, setQueue] = useState(initialQueue);
  const [currentId, setCurrentId] = useState(initialQueue[0].id);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(38);
  const [volume, setVolume] = useState(70);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<0 | 1 | 2>(0);
  const [queueOpen, setQueueOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [playlistError, setPlaylistError] = useState("");
  const [playlistTrackQuery, setPlaylistTrackQuery] = useState("");
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null);
  const [toast, setToast] = useState("");
  const [pageLimit, setPageLimit] = useState(40);
  const [dense, setDense] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [musicDirectory, setMusicDirectory] = useState("/music");
  const [directoryConfigured, setDirectoryConfigured] = useState(true);
  const [directorySelection, setDirectorySelection] = useState("/music");
  const [checkStatus, setCheckStatus] = useState<Record<CheckKind, CheckStatus>>({ service: "idle", directory: "idle", partial: "idle" });
  const retryTimer = useRef<number | null>(null);
  const [contentScrollbarWidth, setContentScrollbarWidth] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [libraryMode, setLibraryMode] = useState<"ready" | "empty" | "unconfigured">("ready");
  const albums = libraryMode === "ready" ? sourceAlbums : [];
  const tracks = libraryMode === "ready" ? sourceTracks : [];
  const [authenticated, setAuthenticated] = useState(false);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [accountId, setAccountId] = useState("room-admin");
  const [accountSessions, setAccountSessions] = useState<Record<string, AccountSession[]>>({ "room-admin": initialSessions(), listener: initialSessions() });
  const accountUser = authenticated ? accounts.find((item) => item.id === accountId && item.status === "active") : undefined;
  const canManageLibrary = !authenticated || accountUser?.role === "admin";
  const personalLibraries = useRef(new Map<string, { favorites: Set<string>; playlists: Playlist[] }>());
  const collectionOwner = useRef("demo");
  const loginReturn = useRef("home");
  const [scan, setScan] = useState<ScanState>(idleScan);
  const [scanHeld, setScanHeld] = useState(false);
  const [phase, setPhase] = useState<PlaybackPhase>("ready");
  const [writeState, setWriteState] = useState<"idle" | "saving" | "error">("idle");
  const [writeLabel, setWriteLabel] = useState("");
  const pendingWrite = useRef<(() => void) | null>(null);
  const writeTimer = useRef<number | null>(null);
  const [orderDraft, setOrderDraft] = useState<string[] | null>(null);
  const [requestState, setRequestState] = useState<"ready" | "loading" | "error">("ready");
  const [moreState, setMoreState] = useState<"ready" | "loading" | "error">("ready");
  const requestTimer = useRef<number | null>(null);
  const scenarioRef = useRef("");
  const hasCurrent = Boolean(currentId);
  const current = trackMap.get(currentId) ?? sourceTracks[0];
  const currentAlbum = albumMap.get(current.albumId)!;
  const currentIndex = queue.findIndex((track) => track.id === currentId);
  const pageRoute = route === "playing" ? backgroundRoute.current : route;
  const browseRoute = useRef(pageRoute);
  const [section, routeId] = pageRoute.split("?")[0].split("/");
  const searching = searchCommitted && query.trim().length > 0;
  const searchSuggestionsOpen = searchFocused && !searching && query.trim().length > 0;
  const loginRoute = section === "login" || (section === "preview" && routeId?.startsWith("login-"));
  const homePage = !searching && (section === "home" || (section === "preview" && ["home-new", "player-empty"].includes(routeId)));
  const catalogPage = !homePage && (searching || ["search", "albums", "album", "songs", "favorites", "playlists", "playlist", "artist", "loading", "error", "preview", "scan", "setup", "directory-unavailable", "account", "admin"].includes(section));
  const libraryDirectoryNeedsScan = libraryMode === "empty" && scan.status === "idle";
  const initialSetup = !directoryConfigured;
  const directoryUnavailable = section === "directory-unavailable" || (section === "preview" && routeId === "directory-unavailable");
  const partialScan = scan.status === "partial";
  const playback = usePrototypeAudio({ trackId: hasCurrent && !loginRoute ? currentId : "", playing: isPlaying && phase === "ready", position, volume, onPosition: setPosition, onEnded: () => nextTrack(true) });
  const playerPhase: PlaybackPhase = phase !== "ready" ? phase : playback.sourceBusy ? "loading" : playback.audioError ? "decode" : "ready";
  const playbackDuration = playback.prepared?.track.duration ?? current.duration;
  const demoAudio = playback.catalog?.enabled === false;

  function announce(message: string) { setToast(""); window.setTimeout(() => setToast(message), 0); }
  function switchAccount(id: string | null) {
    cancelWrite();
    personalLibraries.current.set(collectionOwner.current, { favorites: new Set(favorites), playlists });
    const owner = id ?? "demo";
    const personal = personalLibraries.current.get(owner) ?? (owner === "room-admin" || owner === "demo" ? { favorites: new Set(startingFavorites), playlists: starterPlaylists } : owner === "listener" ? { favorites: new Set(sourceTracks.slice(0, 3).map((item) => item.id)), playlists: [{ ...starterPlaylists[0], name: "漫游的午后" }] } : { favorites: new Set<string>(), playlists: [] });
    collectionOwner.current = owner; setFavorites(new Set(personal.favorites)); setPlaylists(personal.playlists);
    setAuthenticated(Boolean(id)); setAccountId(id ?? "room-admin");
    setQueue([]); setCurrentId(""); setPosition(0); setIsPlaying(false); setQueueOpen(false); setPhase("ready");
    if (id) setAccountSessions((previous) => ({ ...previous, [id]: previous[id]?.some((session) => session.current) ? previous[id] : initialSessions().slice(0, 1) }));
  }
  function updateAccount(next: AccountUser) {
    const before = accounts.find((item) => item.id === next.id);
    setAccounts((previous) => previous.map((item) => item.id === next.id ? next : item));
    if (next.status === "disabled" || (next.mustChangePassword && !before?.mustChangePassword)) setAccountSessions((previous) => ({ ...previous, [next.id]: [] }));
  }
  function signOut(reason = "signed-out") {
    setModal(null); loginReturn.current = "account";
    setAccountSessions((previous) => ({ ...previous, [accountId]: (previous[accountId] ?? []).filter((session) => !session.current) }));
    switchAccount(null); navigate(`login?reason=${reason}`);
  }
  function renderAccount(view: "profile" | "security" | "users" | "denied" = "profile", scene = "") {
    return <AccountPages key={`${scene || view}-${accountUser?.id ?? "guest"}`} user={accountUser} users={accounts} sessions={accountSessions[accountId] ?? initialSessions().slice(0, 1)} view={view} scene={scene} favoriteCount={favorites.size} playlistCount={playlists.length}
      onUserChange={updateAccount} onCreate={(created) => setAccounts((previous) => [...previous, created])}
      onRevoke={(ids) => setAccountSessions((previous) => ({ ...previous, [accountId]: (previous[accountId] ?? initialSessions()).filter((session) => !ids.includes(session.id)) }))}
      onNavigate={navigate} onLogin={() => { loginReturn.current = pageRoute; navigate("login"); }} onLogout={signOut} onDirectory={() => setModal({ type: "settings" })} onNotice={announce} />;
  }
  function retryLibrary(kind: CheckKind) {
    if (!canManageLibrary && kind !== "service") { navigate("account/permissions"); return; }
    if (kind === "partial") { startDirectoryScan(musicDirectory); return; }
    if (checkStatus[kind] === "checking") return;
    setCheckStatus((previous) => ({ ...previous, [kind]: "checking" }));
    retryTimer.current = window.setTimeout(() => {
      setCheckStatus((previous) => ({ ...previous, [kind]: "complete" }));
      if (kind === "directory") startDirectoryScan(musicDirectory);
      else { navigate("home"); announce("曲库已重新连接"); }
    }, 1000);
  }
  function startDirectoryScan(path: string, outcome: ScanOutcome = "complete") {
    if (!canManageLibrary) { setModal(null); navigate("account/permissions"); return; }
    setMusicDirectory(path); setDirectoryConfigured(true); setModal(null); setScanHeld(false);
    setScan(beginScan(path, outcome)); navigate("scan");
  }
  function cancelWrite() {
    if (writeTimer.current) window.clearTimeout(writeTimer.current);
    pendingWrite.current = null; setWriteState("idle");
  }
  function finishWrite() {
    if (!pendingWrite.current) return;
    setWriteState("saving");
    writeTimer.current = window.setTimeout(() => {
      pendingWrite.current?.(); pendingWrite.current = null; setWriteState("idle"); announce("已保存");
    }, 650);
  }
  function saveChange(label: string, apply: () => void) {
    if (writeState !== "idle") return;
    setWriteLabel(label); pendingWrite.current = apply; finishWrite();
  }
  function closeDialog() { cancelWrite(); setModal(null); }
  function renderWriteFeedback(compact = false) {
    if (writeState === "idle") return null;
    const saving = writeState === "saving";
    const title = saving ? `正在${writeLabel}` : `${writeLabel}失败`;
    const detail = saving ? "稍等一下，即将完成。" : "连接暂时中断，原内容未改变，你的修改仍保留着。";
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
  function retryPlayback() {
    if (playback.audioError && phase === "ready") { playback.retryAudio(); return; }
    if (phase === "missing") { closePlayer(); navigate("directory-unavailable"); return; }
    play(current);
  }
  function loadMore() {
    setMoreState("loading");
    requestTimer.current = window.setTimeout(() => { setPageLimit((value) => value + 60); setMoreState("ready"); }, 700);
  }
  function retryContent() {
    setRequestState("loading");
    requestTimer.current = window.setTimeout(() => setRequestState("ready"), 750);
  }
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
  function play(track: Track, source?: Track[]) {
    if (!track) return;
    playback.unlock();
    if (source?.length) setQueue(source);
    else if (!queue.some((item) => item.id === track.id)) setQueue((items) => [...items, track]);
    if (track.id === currentId) playback.seek(0);
    setCurrentId(track.id); setPosition(0);
    setPhase("ready"); setIsPlaying(true);
  }
  function togglePlay() { if (!hasCurrent) return; if (playerPhase !== "ready") { if (!playbackBusy(playerPhase)) retryPlayback(); return; } playback.unlock(); setIsPlaying((value) => !value); }
  function nextTrack(auto = false) {
    if (!queue.length) return;
    if (auto && repeat === 2) { playback.seek(0); return; }
    const index = queue.findIndex((track) => track.id === currentId);
    if (auto && index >= queue.length - 1 && repeat === 0 && !shuffle) { setIsPlaying(false); setPosition(playbackDuration); return; }
    const next = shuffle && queue.length > 1 ? (index + 1 + Math.floor(Math.random() * (queue.length - 1))) % queue.length : (index + 1) % queue.length;
    play(queue[next]);
  }
  function previousTrack() {
    if (!hasCurrent) return;
    if (position > 3) { playback.seek(0); return; }
    play(queue[(Math.max(currentIndex, 0) - 1 + queue.length) % queue.length] ?? current);
  }
  function toggleFavorite(id: string) {
    saveChange("保存收藏", () => setFavorites((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }));
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
    const playlist: Playlist = { id: crypto.randomUUID(), name, description: "喜欢的音乐，慢慢收集。", trackIds: modal && "trackId" in modal && modal.trackId ? [modal.trackId] : [] };
    saveChange("创建歌单", () => { setPlaylists((items) => [...items, playlist]); setNewPlaylistName(""); setPlaylistError(""); setModal(null); navigate(`playlist/${playlist.id}`); });
  }
  function addToPlaylist(id: string, trackId: string) {
    const playlist = playlists.find((item) => item.id === id)!;
    if (playlist.trackIds.includes(trackId)) { announce("这首歌已经在歌单里了"); setModal(null); return; }
    saveChange("添加歌曲", () => { setPlaylists((items) => items.map((item) => item.id === id ? { ...item, trackIds: [...item.trackIds, trackId] } : item)); setModal(null); });
  }
  function moveQueue(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= queue.length) return;
    setQueue((previous) => { const next = [...previous]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  }

  // 预览只切换内存中的演示场景；进入其他页面后，场景中的操作仍可继续。
  useLayoutEffect(() => {
    const [prefix, scene = ""] = route.split("?")[0].split("/");
    if (prefix !== "preview" || scenarioRef.current === route || (scene && !previewGroups.some((group) => group.items.some(([id]) => id === scene)))) return;
    scenarioRef.current = route;
    cancelWrite();
    if (requestTimer.current) window.clearTimeout(requestTimer.current);
    setModal(null); setQueueOpen(false); setIsPlaying(false); setPhase("ready"); setOrderDraft(null);
    setRequestState("ready"); setMoreState("ready"); setScanHeld(false); setScan(idleScan); setPosition(38);
    setLibraryMode("ready"); setDirectoryConfigured(true); setMusicDirectory("/music");
    setAccounts(initialAccounts); setAccountId("room-admin"); setAuthenticated(false);
    setAccountSessions({ "room-admin": initialSessions(), listener: initialSessions() });
    personalLibraries.current.clear(); collectionOwner.current = "demo";
    setFavorites(new Set(startingFavorites)); setPlaylists(starterPlaylists); setQueue(initialQueue); setCurrentId(initialQueue[0].id);
    const emptyLibrary = ["setup-empty", "library-empty", "albums-empty", "artists-empty", "scan-empty"].includes(scene);
    if (emptyLibrary) {
      setLibraryMode(scene === "setup-empty" ? "unconfigured" : "empty"); setDirectoryConfigured(scene !== "setup-empty");
      setFavorites(new Set()); setPlaylists([]); setQueue([]); setCurrentId(""); setPosition(0);
    }
    if (["home-new", "player-empty"].includes(scene)) { setCurrentId(""); setQueue([]); setPosition(0); }
    if (["home-new", "playlists-empty"].includes(scene)) setPlaylists([]);
    if (["home-new", "favorites-empty"].includes(scene)) setFavorites(new Set());
    if (scene === "playlist-empty") setPlaylists([{ id: "new", name: "今天的声音", description: "喜欢的音乐，慢慢收集。", trackIds: [] }]);
    if (scene.startsWith("scan-")) {
      const state = scene.slice(5) as ScanState["status"];
      const outcome = state === "empty" ? "empty" : state === "partial" ? "partial" : "complete";
      const seed = beginScan("/music", outcome);
      setScan({ ...seed, status: state, processed: ["complete", "empty", "partial"].includes(state) ? seed.total : state === "failed" ? 0 : 528 });
      setScanHeld(state === "running");
    }
    if (scene === "directory-unavailable") setMusicDirectory("/Volumes/Music");
    if (scene.startsWith("player-") && scene !== "player-empty") setPhase(scene.slice(7) as PlaybackPhase);
    if (scene === "queue-empty") setQueue([initialQueue[0]]);
    if (scene.startsWith("login-")) { setAuthenticated(false); loginReturn.current = scene === "login-expired" ? "playlist/night" : "home"; }
    if (scene === "account" || scene.startsWith("account-") || scene.startsWith("accounts-")) {
      const member = ["account-member", "account-denied"].includes(scene);
      setAuthenticated(true); setAccountId(member ? "listener" : "room-admin"); collectionOwner.current = member ? "listener" : "room-admin";
      if (member) { setFavorites(new Set(sourceTracks.slice(0, 3).map((item) => item.id))); setPlaylists([{ ...starterPlaylists[0], name: "漫游的午后" }]); }
    }
    if (scene === "playlist-rename" || scene === "playlist-delete") { setNewPlaylistName(starterPlaylists[2].name); setPlaylistError(""); setModal({ type: scene === "playlist-rename" ? "rename" : "delete", playlistId: "night" }); }
    if (scene === "playlist-order") setOrderDraft([...starterPlaylists[2].trackIds]);
    if (scene === "playlist-save-error") {
      setNewPlaylistName("夜色与旋律"); setPlaylistError(""); setModal({ type: "rename", playlistId: "night" });
      setWriteLabel("保存歌单名称"); setWriteState("error");
      pendingWrite.current = () => { setPlaylists((items) => items.map((item) => item.id === "night" ? { ...item, name: "夜色与旋律" } : item)); setModal(null); };
    }
    if (scene === "save-error" || scene === "save-pending") {
      setWriteLabel("保存收藏"); pendingWrite.current = () => setFavorites((previous) => new Set([...previous, sourceTracks[0].id]));
      setWriteState(scene === "save-error" ? "error" : "saving");
    }
    if (["list-error", "detail-error", "search-partial"].includes(scene)) setRequestState("error");
    if (["list-loading", "detail-loading"].includes(scene)) setRequestState("loading");
    if (scene === "more-error") { setMoreState("error"); setPageLimit(4); }
    if (scene.startsWith("search-")) setQuery(scene === "search-empty" ? "zzzz-no-match" : "西木康智");
  }, [route]);
  useEffect(() => {
    if (scan.status !== "running" || scanHeld) return;
    const timer = window.setInterval(() => setScan(advanceScan), 850);
    return () => window.clearInterval(timer);
  }, [scan.status, scanHeld]);
  useEffect(() => {
    if (!["complete", "partial", "empty"].includes(scan.status)) return;
    setLibraryMode(scan.status === "empty" ? "empty" : "ready");
    if (scan.status === "empty") { setCurrentId(""); setQueue([]); setIsPlaying(false); }
    announce(scan.status === "empty" ? "扫描完成，未发现可播放文件" : scan.status === "partial" ? "扫描部分完成，可以查看失败详情" : "扫描完成，音乐已经准备好");
  }, [scan.status]);
  useEffect(() => () => {
    if (requestTimer.current) window.clearTimeout(requestTimer.current);
    if (writeTimer.current) window.clearTimeout(writeTimer.current);
  }, []);
  useEffect(() => { if (section !== "preview") setOrderDraft(null); }, [pageRoute]);

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
  useEffect(() => { if (playback.realAudio || !isPlaying || !hasCurrent || playerPhase !== "ready") return; const timer = window.setInterval(() => setPosition((value) => Math.min(value + 1, current.duration)), 1000); return () => window.clearInterval(timer); }, [isPlaying, hasCurrent, playerPhase, current.duration, playback.realAudio]);
  useEffect(() => { if (!playback.realAudio && isPlaying && position >= current.duration) nextTrack(true); }, [position, current.duration, isPlaying, playback.realAudio]);
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
  }, [modal, queueOpen, searchSuggestionsOpen, searching, section, playerPhase, phase, hasCurrent, currentId, loginRoute, playback.audio, playback.audioError]);
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
    return <article className="album-card" key={album.id}>
      <div className="album-cover-wrap artwork-card">
        <button className="cover-link" onClick={() => navigate(`album/${album.id}`)} aria-label={`打开专辑 ${album.name}`}><Cover album={album} /></button>
        <button className="cover-play" aria-label={`播放专辑 ${album.name}`} onClick={() => play(albumTracks(album.id)[0], albumTracks(album.id))}><Play fill="currentColor" /></button>
      </div>
      <button className="album-name" title={album.title} onClick={() => navigate(`album/${album.id}`)}>{album.name}</button>
      <p>{album.artist}</p><span className="album-year">{yearLabel(album.year)} · {album.genre}</span>
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
          {!options.hideAlbum && <button className="track-album" onClick={() => navigate(`album/${album.id}`)}>{album.name}</button>}
          <span className="quality-tag">{track.format || "—"}</span><span className="track-duration">{trackTime(track.duration)}</span>
          <div className="track-actions"><IconButton label={favorites.has(track.id) ? `取消收藏 ${displayTitle(track)}` : `收藏 ${displayTitle(track)}`} active={favorites.has(track.id)} disabled={writeState !== "idle"} onClick={() => toggleFavorite(track.id)}><Heart fill={favorites.has(track.id) ? "currentColor" : "none"} /></IconButton>
            {options.playlistId ? <IconButton label={`从歌单移除 ${displayTitle(track)}`} disabled={writeState !== "idle"} onClick={() => saveChange("移除歌曲", () => setPlaylists((items) => items.map((item) => item.id === options.playlistId ? { ...item, trackIds: item.trackIds.filter((id) => id !== track.id) } : item)))}><X /></IconButton> : <button className="icon-button track-more" aria-label={`${displayTitle(track)} 的更多操作`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ track, x: Math.min(rect.right - 210, window.innerWidth - 226), y: Math.min(rect.bottom + 4, window.innerHeight - 235) }); }}><MoreHorizontal /></button>}
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
        <button className="playlist-quick-play" aria-label={`播放歌单 ${playlist.name}`} disabled={!list.length} onClick={() => play(list[0], list)}><Play fill="currentColor" /></button>
      </div>
      <div className="playlist-collection-copy"><button className="playlist-title" onClick={() => navigate(`playlist/${playlist.id}`)}>{playlist.name}</button><p>{playlist.description}</p><span><ListMusic />{list.length} 首<span>·</span>{durationLabel(list.reduce((sum, track) => sum + track.duration, 0))}</span></div>
    </article>;
  }
  function renderHome() {
    if (!albums.length || !tracks.length) return renderLibraryEmpty();
    return <>
      <div className="home-intro"><span className="eyebrow">你的音乐空间</span><h1>音乐，刚刚好。</h1><p>留一点时间，给喜欢的声音。</p></div>
      <section className="home-highlights" aria-label="聆听推荐">
        <article className="featured-record">
          <div className="featured-copy">
            <span className="featured-kicker"><Disc3 />今日精选</span>
            <h2>{featured.name}</h2>
            <p className="featured-credit">{featured.artist} · {yearLabel(featured.year)}</p>
            <p className="featured-description">从熟悉的旋律出发，<br />重返故事里的世界。</p>
            <div className="featured-actions">
              <button className="button primary" onClick={() => play(albumTracks(featured.id)[0], albumTracks(featured.id))}><Play size={16} fill="currentColor" />播放专辑</button>
              <button className="text-button" onClick={() => navigate(`album/${featured.id}`)}>查看专辑<ChevronRight /></button>
            </div>
          </div>
          <button className="featured-artwork" aria-label={`查看今日精选 ${featured.name}`} onClick={() => navigate(`album/${featured.id}`)}><Cover album={featured} lazy={false} /></button>
        </article>
        {hasCurrent ? <article className="resume-card">
          <div className="resume-heading"><span>继续聆听</span><Headphones /></div>
          <button className="resume-artwork" aria-label={`查看正在播放的专辑 ${currentAlbum.name}`} onClick={() => navigate(`album/${currentAlbum.id}`)}><Cover album={currentAlbum} lazy={false} /></button>
          <div className="resume-details"><strong title={current.title}>{displayTitle(current)}</strong><span>{current.artist}</span></div>
          <IconButton className="resume-control" label={isPlaying ? "暂停当前歌曲" : "继续播放"} onClick={togglePlay}>{isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</IconButton>
          <div className="resume-progress" aria-hidden="true"><span style={{ width: `${position / current.duration * 100}%` }} /></div>
        </article> : <article className="resume-card resume-empty"><Headphones /><h2>从第一首开始</h2><p>还没有聆听记录。<br />挑一张喜欢的唱片，留下今天的声音。</p><button className="button subtle" onClick={() => navigate("albums")}>去听听</button></article>}
      </section>
      <section className="home-albums">{sectionHeading("最近加入", "每一次收藏，都值得认真听见。", <button className="text-button" onClick={() => navigate("albums")}>全部专辑<ChevronRight /></button>)}<div className="album-grid home-album-grid">{albums.slice(0, 5).map(albumCard)}</div></section>
      <section className="home-playlists">{sectionHeading("为不同的时刻", "你的生活，自己的配乐。", <button className="text-button" onClick={() => navigate("playlists")}>我的歌单<ChevronRight /></button>)}{playlists.length ? <div className="playlist-collection-grid">{playlists.slice(0, 3).map(collectionPlaylistCard)}</div> : <div className="home-empty-collection"><ListMusic /><div><h3>给今天，留一张歌单</h3><p>把喜欢的音乐慢慢收集起来。</p></div><button className="button subtle" onClick={() => openCreatePlaylist()}>新建歌单</button></div>}</section>
      <section className="home-collection">
        <div>{sectionHeading("一听，就很喜欢", "让这些旋律多陪你一会儿。", <button className="text-button" onClick={() => navigate("favorites")}>全部收藏<ChevronRight /></button>)}<div className="home-favorites-list">{trackList(tracks.filter((track) => favorites.has(track.id)).slice(0, 4), { compact: true, limit: 4 })}</div></div>
        <aside className="library-summary"><span className="eyebrow">本地音乐库</span><h3>你的音乐，都在这里。</h3><div className="library-summary-stats"><div><strong>{tracks.length.toLocaleString()}</strong><span>首歌曲</span></div><div><strong>{albums.length}</strong><span>张专辑</span></div></div><p>{durationLabel(tracks.reduce((sum, track) => sum + track.duration, 0))}，慢慢听。</p><button className="text-button" onClick={() => setModal({ type: "info" })}>关于这间音乐室<ChevronRight /></button></aside>
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
        <div className="detail-copy"><span className="eyebrow">专辑 · {album.genre} · {yearLabel(album.year)}</span><h1>{album.name}</h1><p className="original-title">{album.title}</p><button className="detail-artist" onClick={() => navigate(`artist/${encodeURIComponent(album.artist)}`)}>{album.artist}<ChevronRight /></button><p className="detail-meta"><span>{album.trackCount} 首歌曲</span><span>·</span><span>{durationLabel(album.duration)}</span><span className="lossless"><Disc3 />无损音质</span></p><div className="detail-actions">{playButton(list)}{shuffleButton(list)}</div></div>
      </section>
      <section className="detail-track-section">
        <div className="detail-track-heading">{collectionLabel("专辑曲目", `${filtered.length} 首`)}
          {discs.length > 1 && <div className="filter-pills disc-tabs" aria-label="选择碟片"><button aria-pressed={albumDiscFilter === "全部"} className={albumDiscFilter === "全部" ? "selected" : ""} onClick={() => { setAlbumDiscFilter("全部"); setPageLimit(40); }}>全部</button>{discs.map((disc) => <button key={disc} aria-pressed={albumDiscFilter === `Disc ${disc}`} className={albumDiscFilter === `Disc ${disc}` ? "selected" : ""} onClick={() => { setAlbumDiscFilter(`Disc ${disc}`); setPageLimit(40); }}>Disc {disc}</button>)}</div>}
        </div>
        {filtered.length ? trackList(filtered, { hideAlbum: true }) : <StatePanel className="state-panel-list" icon={Disc3} title="这个碟片还没有歌曲" description="换一张碟片，或者回到专辑列表继续浏览。" actions={[{ label: "回到唱片架", onClick: () => navigate("albums") }]} />}
      </section>
      <p className="detail-endnote">{yearLabel(album.year)} · {album.genre} · {album.trackCount} 首歌曲</p>
    </>;
  }
  function renderArtists() {
    const artistNames = [...new Set(albums.map((album) => album.artist))];
    return <>{pageHeading("BEHIND THE MUSIC", "旋律背后的人", "循着一个名字，听见更多喜欢的声音。")}
      {artistNames.length ? <div className="artist-grid">{artistNames.map((name) => { const discography = albums.filter((album) => album.artist === name); return <button className="artist-card" key={name} onClick={() => navigate(`artist/${encodeURIComponent(name)}`)}><div className="artist-art artwork-card"><Cover album={discography[0]} /></div><h2>{name}</h2><p>{discography.length} 张专辑 · {discography.reduce((sum, album) => sum + album.trackCount, 0)} 首歌曲</p></button>; })}</div> : renderLibraryEmpty()}</>;
  }
  function renderArtist(id: string) {
    let name = ""; try { name = decodeURIComponent(id); } catch { return renderNotFound("artist"); }
    const artistAlbums = albums.filter((album) => album.artist === name);
    const artistAlbumIds = new Set(artistAlbums.map((album) => album.id));
    const list = tracks.filter((track) => track.artist === name || artistAlbumIds.has(track.albumId));
    const resultAlbumIds = new Set(list.map((track) => track.albumId));
    const results = albums.filter((album) => resultAlbumIds.has(album.id) || artistAlbumIds.has(album.id));
    if (!results.length) return renderNotFound("artist");
    return <>
      <button className="back-link" onClick={() => navigate("artists")}><ArrowLeft />全部艺人</button>
      <section className="detail-hero artist-profile"><div className="artist-detail-art artwork-card"><Cover album={results[0]} lazy={false} /></div><div className="detail-copy"><span className="eyebrow">艺人作品</span><h1>{name}</h1><p className="playlist-description">循着熟悉的名字，听见更多喜欢的声音。</p><p className="detail-meta">{results.length} 张专辑<span>·</span>{list.length} 首作品</p><div className="detail-actions">{playButton(list)}{shuffleButton(list)}</div></div></section>
      <section>{collectionLabel("专辑与参与作品", `${results.length} 张`)}<div className="album-grid collection-grid">{results.map(albumCard)}</div></section>
      <section className="artist-tracks">{collectionLabel("从这些旋律开始", `${Math.min(12, list.length)} 首`)}{list.length ? trackList(list, { limit: 12 }) : <StatePanel className="state-panel-list" icon={Music2} title="这位艺人还没有歌曲" description="回到艺人列表，看看其他创作者的作品。" actions={[{ label: "回到艺人", onClick: () => navigate("artists") }]} />}</section>
    </>;
  }
  function renderPlaylist(playlist?: Playlist) {
    if (!playlist) return renderNotFound("playlist");
    const list = playlist.trackIds.map((id) => trackMap.get(id)!).filter(Boolean);
    return <>
      <button className="back-link" onClick={() => navigate("playlists")}><ArrowLeft />我的歌单</button>
      <section className={`detail-hero playlist-detail${list.length ? "" : " is-empty"}`}><div className="playlist-detail-art artwork-card"><PlaylistArt playlist={playlist} /></div><div className="detail-copy"><span className="eyebrow">私人歌单</span><h1>{playlist.name}</h1><p className="playlist-description">{playlist.description}</p><p className="detail-meta">{list.length} 首歌曲<span>·</span>{durationLabel(list.reduce((sum, track) => sum + track.duration, 0))}</p><div className="detail-actions">{playButton(list)}{shuffleButton(list)}</div><div className="playlist-management"><button onClick={() => { setNewPlaylistName(playlist.name); setPlaylistError(""); setModal({ type: "rename", playlistId: playlist.id }); }}><Pencil />重命名</button><button onClick={() => setModal({ type: "delete", playlistId: playlist.id })}><Trash2 />删除歌单</button></div></div></section>
      <section className={`playlist-tracks${list.length ? "" : " is-empty"}`}><div className="detail-track-heading">{collectionLabel("歌单中的音乐", `${list.length} 首`)}{list.length > 0 && <div className="playlist-management">{list.length > 1 && !orderDraft && <button onClick={() => setOrderDraft([...playlist.trackIds])}><ListMusic />调整顺序</button>}<button className="text-button add-tracks" disabled={Boolean(orderDraft)} onClick={() => openPlaylistAdd(playlist.id)}><Plus />添加歌曲</button></div>}</div>
      {orderDraft ? <PlaylistOrderEditor
        items={orderDraft.map((id) => { const track = trackMap.get(id)!; return { id, title: displayTitle(track), artist: track.artist, artwork: <Cover album={albumMap.get(track.albumId)!} /> }; })}
        writeState={writeState} onChange={setOrderDraft}
        onCancel={() => { cancelWrite(); setOrderDraft(null); }}
        onSave={() => saveChange("保存歌曲顺序", () => { setPlaylists((items) => items.map((item) => item.id === playlist.id ? { ...item, trackIds: [...orderDraft] } : item)); setOrderDraft(null); })}
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
      <div className="collection-toolbar songs-filter-bar"><div className="filter-pills" aria-label="筛选音频格式">{["全部", "FLAC", "ALAC"].map((item) => <button key={item} aria-pressed={formatFilter === item} className={formatFilter === item ? "selected" : ""} onClick={() => { setFormatFilter(item); setPageLimit(40); }}>{item === "全部" ? "全部格式" : item}</button>)}</div><span className="result-count">{list.length.toLocaleString()} 首歌曲</span></div>
      {list.length ? trackList(list) : <StatePanel className="state-panel-list" icon={Music2} title={`还没有 ${formatFilter} 格式的歌曲`} description="换个格式，继续发现你的音乐。" actions={[{ label: "查看全部歌曲", variant: "subtle", onClick: () => setFormatFilter("全部") }]} />}
    </>;
  }
  function getSearchMatches(value = query) {
    const term = value.trim().toLocaleLowerCase();
    const matchingArtists = [...new Set(albums.map((album) => album.artist))].filter((artist) => artist.toLocaleLowerCase().includes(term));
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
        {matchingAlbums.slice(0, 3).map((album) => <button type="button" className="search-suggestion-row" key={`album-${album.id}`} onClick={() => navigate(`album/${album.id}`)}><Cover album={album} /><span><strong>{album.name}</strong><small>{album.artist} · 专辑</small></span><ChevronRight /></button>)}
        {matchingTracks.slice(0, 4).map((track) => <button type="button" className="search-suggestion-row" key={`track-${track.id}`} onClick={() => { play(track); clearSearch(); }}><Cover album={albumMap.get(track.albumId)!} /><span><strong>{displayTitle(track)}</strong><small>{track.artist} · 歌曲</small></span><Play fill="currentColor" /></button>)}
      </div>}
      {hasMatches && <div className="search-suggestions-footer"><kbd>Enter</kbd><span>查看全部搜索结果</span></div>}
    </div>;
  }
  function renderSearch() {
    const { matchingArtists, matchingAlbums, matchingTracks } = getSearchMatches();
    const partial = section === "preview" && routeId === "search-partial" && requestState !== "ready";
    return <>{pageHeading("音乐库 / 搜索", `寻找「${query.trim()}」`, partial ? `${matchingArtists.length} 位艺人 · ${matchingTracks.length} 首歌曲 · 专辑结果暂未载入` : `${matchingArtists.length} 位艺人 · ${matchingAlbums.length} 张专辑 · ${matchingTracks.length} 首歌曲`)}
      {!matchingArtists.length && !matchingAlbums.length && !matchingTracks.length ? <StatePanel className="search-empty" icon={Search} eyebrow="搜索" title="还没有找到这段旋律" description="试试「西木康智」「歧路旅人」或歌曲名称。" actions={[{ label: "重新搜索", variant: "subtle", onClick: () => clearSearch(true) }, { label: "回到首页", onClick: () => navigate("home") }]} /> : <>
        {matchingArtists.length > 0 && <section className="search-artists">{sectionHeading("艺人", `${matchingArtists.length} 位`)}<div className="search-artist-list">{matchingArtists.map((name) => <button key={name} onClick={() => navigate(`artist/${encodeURIComponent(name)}`)}><span><UserRound /></span><strong>{name}</strong><ChevronRight /></button>)}</div></section>}
        <section className="search-albums">{sectionHeading("专辑", partial ? undefined : `${matchingAlbums.length} 张`)}{partial ? <div className="inline-request-state" role="status">{requestState === "loading" ? <LoaderCircle className="button-spinner" /> : <AlertTriangle />}<span>{requestState === "loading" ? "正在重新载入专辑…" : "专辑结果暂时没有载入，艺人和歌曲仍可浏览。"}</span><button className="button subtle" disabled={requestState === "loading"} onClick={retryContent}>重试</button></div> : matchingAlbums.length ? <div className="album-grid collection-grid">{matchingAlbums.map(albumCard)}</div> : <p className="muted-copy">没有匹配的专辑。</p>}</section>
        {matchingTracks.length > 0 && <section>{sectionHeading("歌曲", `${matchingTracks.length} 首`, playButton(matchingTracks))}{trackList(matchingTracks)}</section>}
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
        <StatePanel className="directory-unavailable-state" tone="error" icon={FolderOpen} eyebrow="目录不可访问" title="暂时读不到这处音乐目录" description={`开听无法读取 ${blockedPath}。已保存的收藏和歌单不会受影响；连接恢复后可以继续扫描。`} busy={checking} actions={[{ label: checking ? "正在检查…" : "重新检查", onClick: () => retryLibrary("directory"), disabled: checking, busy: checking }, { label: "选择其他目录", variant: "subtle", onClick: () => { setDirectorySelection("/music"); setModal({ type: "directory", returnTo: "directory-unavailable" }); } }, { label: "回到首页", variant: "subtle", onClick: () => navigate("home") }]} />
        <div className="incident-meta" aria-label="目录检查信息">
          <div><span>当前目录</span><strong>{blockedPath}</strong></div>
          <div><span>可能原因</span><strong>NAS 未挂载或访问权限已改变</strong></div>
          <div><span>建议处理</span><strong>确认网络连接和目录权限，再重新检查</strong></div>
        </div>
      </section>
    </>;
  }
  function renderPartialScan() {
    const checking = checkStatus.partial === "checking";
    const inspected = tracks.length + scanFailures.length;
    return <>
      {pageHeading("音乐库 / 扫描结果", "这次扫描没有完全成功", `${inspected.toLocaleString()} 个文件已检查，保留可读取内容。`)}
      <section className="partial-scan-page" aria-label="部分扫描失败">
        <div className="partial-scan-banner" role="status" aria-live="polite" aria-busy={checking}>
          <span className="partial-scan-icon"><RefreshCw className={checking ? "is-spinning" : ""} aria-hidden="true" /></span>
          <div className="partial-scan-copy"><span className="eyebrow">扫描结果</span><h2>{checking ? "正在重新检查文件" : "已载入可读取的音乐"}</h2><p>{checking ? "正在验证失败文件，请保持目录连接。" : `已读取 ${tracks.length.toLocaleString()} 首歌曲和 ${albums.length} 张专辑，另有 ${scanFailures.length} 个文件未能读取。`}</p></div>
          <div className="partial-scan-actions"><button type="button" className="button primary" onClick={() => retryLibrary("partial")} disabled={checking}>{checking && <LoaderCircle className="button-spinner" aria-hidden="true" />}{checking ? "正在扫描…" : "重新扫描"}</button><button type="button" className="button subtle" onClick={() => setModal({ type: "scan-failures" })}>查看失败详情</button></div>
        </div>
        <section className="partial-results"><div className="section-heading"><div><h2>已载入内容</h2><p>可读取的专辑和歌曲仍然可以播放、收藏和加入歌单。</p></div><span className="result-count">{albums.length} 张专辑 · {tracks.length.toLocaleString()} 首歌曲</span></div><div className="album-grid collection-grid">{albums.slice(0, 6).map(albumCard)}</div></section>
        <div className="partial-scan-note"><AlertTriangle aria-hidden="true" /><p>修复目录连接或文件权限后，再次扫描即可补齐缺失内容。</p><button type="button" className="text-button" onClick={() => setModal({ type: "scan-failures" })}>查看 3 个失败文件</button></div>
      </section>
    </>;
  }
  function renderCompleteScan() {
    return <>
      {pageHeading("音乐库 / 扫描结果", "曲库已经准备好", `${tracks.length.toLocaleString()} 个文件已完成扫描。`)}
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
    if (!initialSetup) return <>{pageHeading("状态预览 / 曲库", "曲库为空", "目录已经选择，模拟等待首次扫描的状态。")}{renderLibraryEmpty("preview-empty-state")}</>;
    return <>
      {pageHeading("状态预览 / 初次设置", "先把音乐带进来", "模拟第一次打开开听、还没有选择音乐目录的状态。")}
      <StatePanel className="preview-empty-state initial-setup-state" icon={FolderOpen} eyebrow="第一次使用" title="还没有连接音乐目录" description="选择一个本地或 NAS 挂载目录，开听会以只读方式扫描你的音乐。" actions={[{ label: "打开设置", onClick: () => { setDirectorySelection(""); setModal({ type: "settings" }); } }, { label: "回到首页", variant: "subtle", onClick: () => navigate("home") }]} />
    </>;
  }
  function renderEmptyPreview(kind: string) {
    if (kind === "library-empty") return <>{pageHeading("状态预览 / 曲库", "曲库为空", "模拟尚未扫描音乐目录的首次进入状态。")}{renderLibraryEmpty("preview-empty-state")}</>;
    if (kind === "albums-empty") return <>{pageHeading("状态预览 / 专辑", "你的唱片架", "模拟曲库中还没有任何专辑的状态。")}{<StatePanel className="preview-empty-state" icon={Disc3} eyebrow="专辑" title="还没有专辑" description="扫描曲库后，专辑封面会出现在这里。" actions={[{ label: "打开设置", onClick: () => setModal({ type: "settings" }) }, { label: "回到首页", variant: "subtle", onClick: () => navigate("home") }]} />}</>;
    if (kind === "artists-empty") return <>{pageHeading("状态预览 / 艺人", "旋律背后的人", "模拟曲库中还没有艺人作品的状态。")}{<StatePanel className="preview-empty-state" icon={UserRound} eyebrow="艺人" title="还没有艺人" description="扫描曲库后，艺人作品会出现在这里。" actions={[{ label: "打开设置", onClick: () => setModal({ type: "settings" }) }, { label: "回到首页", variant: "subtle", onClick: () => navigate("home") }]} />}</>;
    if (kind === "playlists-empty") return renderPlaylists();
    return renderNotFound();
  }
  function renderScan() {
    if (scan.status === "complete") return renderCompleteScan();
    if (scan.status === "partial") return renderPartialScan();
    if (scan.status === "idle") return <StatePanel icon={FolderOpen} title="从连接音乐目录开始" description="选择目录后，开听会自动扫描其中的音乐。" actions={[{ label: "选择目录", onClick: () => setModal({ type: "directory", returnTo: "settings" }) }]} />;
    if (scan.status === "empty") return <>{pageHeading("音乐库 / 扫描结果", "目录里还没有可播放的音乐", `已检查 ${scan.total} 个文件 · ${scan.path}`)}<StatePanel className="preview-empty-state" icon={FolderOpen} eyebrow="扫描完成 · 0 首歌曲" title="换一处，继续发现音乐" description="目录可能为空，或文件格式暂不支持。确认目录中包含音频文件，也可以选择另一个音乐目录。" actions={[{ label: "更换目录", onClick: () => setModal({ type: "directory", returnTo: "settings" }) }, { label: "重新扫描", variant: "subtle", onClick: () => startDirectoryScan(musicDirectory) }]} /></>;
    if (scan.status === "failed" || scan.status === "interrupted") return <>{pageHeading("音乐库 / 扫描", scan.status === "failed" ? "扫描还没有开始" : "这次扫描中断了", scan.path)}<StatePanel className="preview-empty-state" tone="error" icon={AlertTriangle} eyebrow={scan.status === "failed" ? "无法启动扫描" : `已检查 ${scan.processed.toLocaleString()} 个文件`} title={scan.status === "failed" ? "暂时无法启动扫描任务" : scan.reason === "stopped" ? "扫描已停止" : "音乐目录的连接断开了"} description={scan.status === "failed" ? "扫描服务暂时没有响应。已有曲库、收藏和歌单仍然保留，请稍后重试。" : scan.reason === "stopped" ? "已停止本次扫描，原曲库索引、收藏和歌单均保留。准备好后可以重新扫描。" : "本次扫描尚未完成，原曲库索引没有被删除。确认 NAS 挂载与网络连接后重新扫描。"} actions={[{ label: "重新扫描", onClick: () => startDirectoryScan(musicDirectory) }, { label: "检查目录", variant: "subtle", onClick: () => setModal({ type: "settings" }) }]} /></>;
    const percentage = Math.round(scan.processed / scan.total * 100);
    return <>{pageHeading("音乐库 / 扫描中", "让音乐，慢慢归位", "可以继续浏览音乐室，扫描会在后台继续。")}
      <section className="scan-progress-page" aria-label="音乐目录扫描进度">
        <span className="scan-orbit"><Disc3 /><LoaderCircle className="button-spinner" /></span>
        <span className="eyebrow">{percentage < 25 ? "发现音乐文件" : percentage < 85 ? "读取歌曲与专辑信息" : "整理封面与曲库索引"}</span><h2>正在扫描你的音乐</h2>
        <p className="scan-path">{scan.path}</p><div className="scan-progress-track" role="progressbar" aria-label="扫描进度" aria-valuemin={0} aria-valuemax={scan.total} aria-valuenow={scan.processed}><span style={{ width: `${percentage}%` }} /></div>
        <div className="scan-progress-count"><span>{scan.processed.toLocaleString()} / {scan.total.toLocaleString()} 个文件</span><strong>{percentage}%</strong></div>
        <p className="muted-copy">正在读取：{scan.path}/Albums · 仅扫描，不改动原文件</p>
        <div className="state-actions">{scanHeld && <button className="button primary" onClick={() => setScanHeld(false)}>继续演示扫描</button>}<button className="button subtle" onClick={() => navigate("home")}>继续浏览</button><button className="text-button" onClick={() => { setScanHeld(false); setScan((previous) => ({ ...previous, status: "interrupted", reason: "stopped" })); }}>停止扫描</button></div>
      </section></>;
  }
  function renderPreviewGallery() {
    return <>{pageHeading("开听 / 设计状态", "每一种状态，都有回应", "查看正常、缺省与异常流程；点击恢复操作，可以继续体验下一步。")}
      <div className="preview-intro"><Info /><p>这里使用独立演示数据。每次进入一个场景会重置该场景，所有操作都只影响当前原型；刷新后恢复默认。动画中的等待状态会停留，便于查看。</p></div>
      {previewGroups.map((group, index) => <section className="preview-group" key={group.name}><div className="preview-group-heading"><span>{String(index + 1).padStart(2, "0")}</span><div><h2>{group.name}</h2><p>{group.description}</p></div><small>{group.items.length} 个状态</small></div><div className="preview-grid">{group.items.map(([id, title]) => <a key={id} href={`#/preview/${id}`}><span>{title}</span><ChevronRight /></a>)}</div></section>)}
    </>;
  }
  function renderResourcePreview(metadata = false) {
    const fallbackAlbum = { ...sourceAlbums[0], name: "未命名专辑", title: "未命名专辑", artist: "未知艺人", year: 0, genre: "未分类", cover: "" };
    const fallbackTrack = { ...sourceTracks[0], title: "未命名歌曲", artist: "未知艺人", duration: 0, format: "" };
    return <>{pageHeading("状态预览 / 内容缺省", metadata ? "让缺失的信息，也能被读懂" : "没有封面，也有音乐的样子", metadata ? "歌曲与艺人保留明确的缺省名称，年份、时长和格式不显示虚假数值。" : "缺少封面与加载失败使用相同的占位图，不影响浏览与播放。")}
      <div className="resource-preview-grid"><article><Artwork src="" alt="未命名专辑封面" /><h2>{metadata ? fallbackAlbum.name : "尚未提供封面"}</h2><p>{metadata ? fallbackAlbum.artist : "保留唱片的轮廓与比例"}</p><small>{metadata ? "年份未知 · 未分类" : "专辑卡片与艺人列表"}</small></article><article><Artwork src="/unavailable-cover-preview.jpg" alt="读取失败的专辑封面" /><h2>{metadata ? "未知年份" : "封面暂时无法载入"}</h2><p>{metadata ? "原信息补齐后，恢复正常显示" : "失败后自动显示占位封面"}</p><small>详情与播放器沿用相同设计</small></article></div>
      <div className="resource-row"><Artwork src="" alt="歌曲封面" /><span><strong>{metadata ? fallbackTrack.title : sourceTracks[0].title}</strong><small>{metadata ? fallbackTrack.artist : sourceTracks[0].artist}</small></span><span>—</span><span>—</span></div>
    </>;
  }
  function renderPlaylistCoverPreview() {
    const examples = [
      { count: 1, title: "1 张专辑", description: "完整展示一张专辑封面。" },
      { count: 2, title: "2 张专辑", description: "左右各一张，平分画面。" },
      { count: 3, title: "3 张专辑", description: "左侧一张，右侧上下两张。" },
      { count: 4, title: "4 张专辑", description: "四张封面组成四宫格。" },
      { count: 6, title: "4 张以上专辑", description: "这里有 6 张专辑，展示前 4 张。" },
      { count: 0, title: "空歌单", description: "添加歌曲后，自动生成封面。" }
    ];
    return <>{pageHeading("状态预览 / 歌单封面", "让封面，跟随音乐组成", "按歌曲顺序取不同专辑，同一专辑只出现一次。")}
      <div className="playlist-cover-preview-grid">{examples.map(({ count, title, description }) => {
        const playlist: Playlist = { id: `cover-preview-${count}`, name: title, description, trackIds: sourceAlbums.slice(0, count).flatMap((album) => albumTracks(album.id).slice(0, 2).map((track) => track.id)) };
        return <article className="playlist-cover-example" key={count}>
          <div className="playlist-cover-example-art artwork-card"><PlaylistArt playlist={playlist} /></div>
          <h2>{title}</h2><p>{description}</p>
        </article>;
      })}</div>
    </>;
  }
  function renderAdditionalPreview(id: string) {
    if (id && !previewGroups.some((group) => group.items.some(([key]) => key === id))) return renderNotFound();
    if (!id) return renderPreviewGallery();
    if (id.startsWith("scan-")) return renderScan();
    if (id === "account" || id.startsWith("account-") || id.startsWith("accounts-")) return renderAccount(id === "account-denied" ? "denied" : id === "account-security" ? "security" : id.startsWith("accounts-") || id === "account-create" ? "users" : "profile", id);
    if (id === "home-new" || id === "player-empty") return renderHome();
    if (id === "playlist-covers") return renderPlaylistCoverPreview();
    if (id === "favorites-empty") return renderFavorites();
    if (id === "playlists-empty") return renderPlaylists();
    if (id === "playlist-empty") return renderPlaylist(playlists.find((item) => item.id === "new"));
    if (id.startsWith("playlist-")) return renderPlaylist(playlists.find((item) => item.id === "night"));
    if (id.startsWith("search-")) return renderSearch();
    if (id === "artwork-missing" || id === "metadata-empty") return renderResourcePreview(id === "metadata-empty");
    if (id.startsWith("list-") || id.startsWith("detail-")) {
      if (requestState === "ready") return id.startsWith("detail-") ? renderAlbum(sourceAlbums[0]) : renderSongs();
      return <>{pageHeading("音乐库", id.startsWith("detail-") ? "专辑详情" : "所有歌曲", "留一点时间，给喜欢的声音。")}{requestState === "loading" ? <ContentSkeleton detail={id.startsWith("detail-")} /> : <StatePanel className="state-panel-list" tone="error" icon={AlertTriangle} title={id.startsWith("detail-") ? "专辑详情暂时没有载入" : "歌曲列表暂时没有载入"} description="连接暂时中断了，已有的播放和收藏不会受到影响。" actions={[{ label: "重新载入", onClick: retryContent }, { label: "回到首页", variant: "subtle", onClick: () => navigate("home") }]} />}</>;
    }
    if (id === "more-error" || id.startsWith("save-")) return renderSongs();
    if (id.startsWith("player-") || id.startsWith("lyrics-") || id === "queue-empty") return renderAlbum(currentAlbum);
    if (id === "not-found") return renderNotFound();
    return renderEmptyPreview(id);
  }
  function renderPage() {
    if (searching) return renderSearch();
    if (section === "account") return renderAccount(routeId === "security" ? "security" : routeId === "permissions" ? "denied" : "profile");
    if (section === "admin") return routeId === "users" ? renderAccount("users") : renderNotFound();
    if (!canManageLibrary && ["scan", "setup", "directory-unavailable"].includes(section)) return renderAccount("denied");
    if (section === "scan") return renderScan();
    if (libraryMode !== "ready" && ["home", "albums", "songs", "artists", "album", "artist"].includes(section)) return initialSetup ? renderSetupEmpty() : renderLibraryEmpty("preview-empty-state");
    if (section === "setup") return renderSetupEmpty();
    if (section === "home") return renderHome();
    if (section === "albums") return renderAlbums();
    if (section === "album") return renderAlbum(albumMap.get(routeId));
    if (section === "artists") return renderArtists();
    if (section === "artist") return renderArtist(routeId);
    if (section === "playlist") return renderPlaylist(playlists.find((item) => item.id === routeId));
    if (section === "playlists") return renderPlaylists();
    if (section === "favorites") return renderFavorites();
    if (section === "songs") return renderSongs();
    if (section === "loading") return renderLibraryLoading();
    if (section === "error") return renderLibraryError();
    if (section === "directory-unavailable") return renderDirectoryUnavailable();
    if (section === "preview" && routeId === "directory-unavailable") return renderDirectoryUnavailable();
    if (section === "preview" && routeId === "setup-empty") return renderSetupEmpty();
    if (section === "preview") return renderAdditionalPreview(routeId);
    return renderNotFound();
  }
  function queueContent() {
    if (!hasCurrent) return <StatePanel icon={ListMusic} title="这里还很安静" description="挑选一首歌曲，开始今天的聆听。" actions={[{ label: "浏览歌曲", onClick: () => { setQueueOpen(false); navigate("songs"); } }]} />;
    return <div className="queue-content"><div className="queue-current"><span className="eyebrow">正在播放</span><div><Cover album={currentAlbum} /><span><strong>{displayTitle(current)}</strong><small>{current.artist}</small></span><span className={`equalizer ${isPlaying ? "is-playing" : "is-paused"}`} aria-hidden="true"><i /><i /><i /></span></div></div><div className="queue-section-label"><span>待播清单 <small>{queue.length} 首</small></span><button onClick={() => { setQueue([current]); announce("已清空其他待播歌曲"); }} disabled={queue.length <= 1}>清空</button></div><div className="queue-tracks">{queue.map((track, index) => <div className={`queue-row ${track.id === currentId ? "current" : ""}`} key={track.id}><button className="queue-track-select" onClick={() => play(track)}><span className="queue-number">{track.id === currentId ? <span className={`equalizer ${isPlaying ? "is-playing" : "is-paused"}`} aria-hidden="true"><i /><i /><i /></span> : String(index + 1).padStart(2, "0")}</span><Cover album={albumMap.get(track.albumId)!} /><span><strong>{displayTitle(track)}</strong><small>{track.artist}</small></span></button><div className="queue-row-actions"><IconButton label={`上移 ${displayTitle(track)}`} disabled={index === 0} onClick={() => moveQueue(index, -1)}><ArrowUp /></IconButton><IconButton label={`下移 ${displayTitle(track)}`} disabled={index === queue.length - 1} onClick={() => moveQueue(index, 1)}><ArrowDown /></IconButton>{track.id !== currentId && <IconButton label={`移除 ${displayTitle(track)}`} onClick={() => setQueue((items) => items.filter((item) => item.id !== track.id))}><X /></IconButton>}</div></div>)}</div></div>;
  }

  if (loginRoute) {
    const issue = section === "preview" ? routeId.slice(6) : new URLSearchParams(route.split("?")[1]).get("reason") ?? "";
    return <>{playback.mediaElement}<LoginScreen key={route} issue={issue} users={accounts} isMobile={isMobile} onSuccess={(user) => { updateAccount(user); switchAccount(user.id); const destination = loginReturn.current; navigate(!directoryConfigured && user.role === "admin" ? "setup" : destination === "preview" || destination.startsWith("preview/login-") ? "account" : destination); announce(`欢迎回来，${user.displayName}`); }} onDemo={() => { switchAccount(null); setLibraryMode("ready"); setDirectoryConfigured(true); navigate("home"); announce("已进入演示音乐室"); }} onPreview={() => navigate("preview")} /></>;
  }

  return <>{playback.mediaElement}<div className={`app ${isMobile ? "mobile-layout" : "desktop-layout"} ${dense ? "dense-layout" : ""} ${darkMode ? "dark-theme" : ""} library-surface ${homePage ? "home-surface" : ""} ${catalogPage ? "catalog-surface" : ""}`}>
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }}>跳到主要内容</a>
    <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`} aria-label="音乐库导航" inert={isMobile && !mobileNavOpen}>
      <button className="brand" aria-label="开听首页" onClick={() => navigate("home")}><span className="brand-mark" aria-hidden="true"><BrandGlyph /></span><span>开听</span></button>
      {isMobile && <IconButton className="close-mobile-nav" label="关闭导航" onClick={() => setMobileNavOpen(false)}><X /></IconButton>}
      <div className="sidebar-content">
        <span className="nav-label">我的音乐</span><nav className="main-nav">{navItems.map(({ route: target, title, icon: Icon }) => <button key={target} aria-label={title} aria-current={!searching && (section === target || section === target.replace(/s$/, "")) ? "page" : undefined} onClick={() => navigate(target)}><Icon /><span>{title}</span>{target === "favorites" && <small>{favorites.size}</small>}</button>)}<button className="compact-playlists" aria-label="我的歌单" aria-current={!searching && (section === "playlists" || section === "playlist") ? "page" : undefined} onClick={() => navigate("playlists")}><ListMusic /><span>我的歌单</span></button></nav>
        <div className="playlist-nav-heading"><button className="nav-label" onClick={() => navigate("playlists")}>我的歌单</button><IconButton label="新建歌单" onClick={() => { setNewPlaylistName(""); setPlaylistError(""); setModal({ type: "create" }); }}><Plus /></IconButton></div>
        <nav className="playlist-nav">{playlists.map((playlist) => <button key={playlist.id} aria-current={routeId === playlist.id ? "page" : undefined} onClick={() => navigate(`playlist/${playlist.id}`)}><div className="sidebar-playlist-art" aria-hidden="true"><PlaylistArt playlist={playlist} /></div><ListMusic /><span>{playlist.name}</span></button>)}</nav>
      </div>
      <div className="sidebar-bottom"><div className="local-library"><span className="status-dot" /><div><strong>本地音乐库</strong><span>{tracks.length.toLocaleString()} 首 · {albums.length} 张专辑</span></div><Disc3 /></div><button className="settings-button login-entry" aria-label={authenticated ? "我的账号" : "登录私人音乐空间"} aria-current={section === "account" || section === "admin" ? "page" : undefined} onClick={() => { if (authenticated) navigate("account"); else { loginReturn.current = pageRoute; navigate("login"); } }}><UserRound /> {authenticated ? "我的账号" : "登录"} <ChevronRight /></button><button className="settings-button" aria-label="音乐室设置" onClick={() => setModal({ type: "settings" })}><Settings2 /> 设置 <ChevronRight /></button></div>
    </aside>
    {isMobile && mobileNavOpen && <button className="nav-backdrop" aria-label="收起导航" onClick={() => setMobileNavOpen(false)} />}
    <div className="workspace" style={{ "--content-scrollbar-width": `${contentScrollbarWidth}px` } as CSSProperties}>
      <header className="topbar">
        {isMobile && <div className="breadcrumbs"><IconButton label="打开导航" onClick={() => setMobileNavOpen(true)}><Library /></IconButton></div>}
        <div className="search-control"><label className="search-field"><Search /><input ref={searchRef} value={query} placeholder="找一首歌、一张专辑、一位艺人" aria-label="搜索歌曲、专辑、艺人" onFocus={() => { setSearchFocused(true); if (searchCommitted) setSearchCommitted(false); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitSearch(); } }} onChange={(event) => { setQuery(event.target.value); setSearchCommitted(false); setSearchFocused(true); setPageLimit(40); }} />{query && <button aria-label="清空搜索" onMouseDown={(event) => event.preventDefault()} onClick={() => clearSearch(true)}><X /></button>}</label>{renderSearchSuggestions()}</div>
      </header>
      <main ref={mainRef} id="main-content" data-route={pageRoute} className="main-content" tabIndex={-1}><div className="page-content" key={searching ? "search" : pageRoute}>{section === "preview" && routeId && <div className="preview-context"><button onClick={() => navigate("preview")}><ArrowLeft />状态总览</button><span>交互预览</span>{routeId === "save-pending" && writeState === "saving" && <button onClick={finishWrite}>完成保存</button>}{["list-loading", "detail-loading"].includes(routeId) && requestState === "loading" && <button onClick={retryContent}>继续演示载入</button>}</div>}{renderPage()}</div></main>
    </div>
    <div className="global-feedback-stack">
      {canManageLibrary && scan.status !== "idle" && section !== "scan" && !(section === "preview" && routeId?.startsWith("scan-")) && <button className="scan-status-link" onClick={() => navigate("scan")}>{scan.status === "running" ? <LoaderCircle className="button-spinner" /> : <Disc3 />}<span>{scan.status === "running" ? `正在扫描 · ${Math.round(scan.processed / scan.total * 100)}%` : ["failed", "interrupted"].includes(scan.status) ? "扫描需要处理" : "扫描已完成"}</span><span>查看{scan.status === "running" ? "进度" : "结果"}</span><ChevronRight /></button>}
      {!modal && route !== "playing" && renderWriteFeedback(true)}
      {hasCurrent && route !== "playing" && <PlaybackFeedback compact isMobile={isMobile} phase={playerPhase} onRetry={retryPlayback} onNext={() => nextTrack()} />}
    </div>
    {hasCurrent ? <CapsulePlayer
      trackId={current.id}
      phase={playerPhase} title={current.title} artist={demoAudio ? "原创演示音源" : current.artist} album={demoAudio ? "非本曲音频" : currentAlbum.title} cover={currentAlbum.cover}
      isMobile={isMobile} playing={isPlaying} position={position} duration={playbackDuration}
      volume={volume} shuffle={shuffle} repeat={repeat} queueOpen={queueOpen}
      onTogglePlay={togglePlay} onPrevious={previousTrack} onNext={() => nextTrack()}
      onToggleShuffle={() => setShuffle((value) => !value)}
      onToggleRepeat={() => setRepeat((value) => ((value + 1) % 3) as 0 | 1 | 2)}
      onSeek={playback.seek} onVolumeChange={setVolume} onOpenPlayer={openPlayer}
      onOpenQueue={() => setQueueOpen(true)}
      onOpenArtist={() => navigate(`artist/${encodeURIComponent(current.artist)}`)}
      onOpenAlbum={() => navigate(`album/${currentAlbum.id}`)}
    /> : <footer className="capsule-player empty-player" aria-label="尚未开始播放"><span className="empty-player-art"><Music2 /></span><span><strong>挑一首，让音乐开始</strong><small>{initialSetup ? "先连接你的音乐目录" : "你的下一段旋律，在这里等你"}</small></span><button onClick={() => initialSetup ? setModal({ type: "settings" }) : navigate("songs")}>{initialSetup ? "连接目录" : "浏览歌曲"}</button></footer>}
    {queueOpen && <Modal className="queue-dialog" label="待播清单" onClose={() => setQueueOpen(false)}><div className="dialog-heading"><div><span className="eyebrow">KEEP THE MUSIC GOING</span><h2>接下来听</h2></div><IconButton label="关闭待播清单" onClick={() => setQueueOpen(false)}><X /></IconButton></div>{queueContent()}</Modal>}
    {hasCurrent && (route === "playing" || (section === "preview" && (routeId?.startsWith("lyrics-") || routeId === "queue-empty"))) && <Modal key={route === "playing" ? "player" : routeId} className="now-playing-dialog" label="沉浸播放器" onClose={closePlayer}>
      {renderWriteFeedback(true)}
      <NowPlaying
        playback={playback}
        phase={playerPhase} onRetry={retryPlayback}
        initialPanel={routeId === "queue-empty" ? "queue" : routeId?.startsWith("lyrics-") ? "lyrics" : undefined}
        initialLyrics={routeId === "lyrics-loading" ? "loading" : routeId === "lyrics-error" ? "error" : routeId === "lyrics-empty" ? "empty" : "ready"}        track={{ ...current, title: displayTitle(current), duration: playbackDuration, cover: currentAlbum.cover }} album={currentAlbum}
        queue={queue.map((track) => ({ ...track, title: displayTitle(track), cover: albumMap.get(track.albumId)!.cover }))}
        isMobile={isMobile} playing={isPlaying} position={position} volume={volume}
        favorite={favorites.has(currentId)} shuffle={shuffle} repeat={repeat}
        onClose={closePlayer} onTogglePlay={togglePlay} onPrevious={previousTrack} onNext={() => nextTrack()}
        onSeek={playback.seek} onVolumeChange={setVolume} onToggleFavorite={() => toggleFavorite(currentId)}
        onToggleShuffle={() => setShuffle((value) => !value)}
        onToggleRepeat={() => setRepeat((value) => ((value + 1) % 3) as 0 | 1 | 2)}
        onOpenAlbum={() => navigate(`album/${currentAlbum.id}`)}
        onOpenArtist={() => navigate(`artist/${encodeURIComponent(current.artist)}`)}
        onSelectTrack={(id) => play(trackMap.get(id)!)} onMoveTrack={moveQueue}
        onRemoveTrack={(id) => setQueue((items) => items.filter((item) => item.id !== id))}
        onClearQueue={() => setQueue([current])}
      />
    </Modal>}
    {modal && <Modal key={modal.type} className="standard-dialog" label={modal.type === "rename" ? "重命名歌单" : modal.type === "delete" ? "删除歌单" : modal.type === "create" ? "新建歌单" : modal.type === "add" ? "添加到歌单" : modal.type === "playlist-add" ? "添加歌曲" : modal.type === "settings" ? "音乐室设置" : modal.type === "directory" ? "选择音乐目录" : modal.type === "scan-failures" ? "扫描失败详情" : "关于原型"} onClose={closeDialog}><div className="dialog-heading"><span className="dialog-symbol">{modal.type === "create" || modal.type === "add" || modal.type === "playlist-add" ? <ListMusic /> : modal.type === "settings" ? <Settings2 /> : modal.type === "directory" ? <FolderOpen /> : modal.type === "scan-failures" ? <AlertTriangle /> : <Disc3 />}</span><IconButton label="关闭对话框" onClick={closeDialog}><X /></IconButton></div><fieldset className="dialog-body" disabled={writeState !== "idle"}>

      {modal.type === "rename" && <form onSubmit={(event) => { event.preventDefault(); const name = newPlaylistName.trim(); if (!name) { setPlaylistError("给歌单起一个名字吧"); return; } saveChange("重命名歌单", () => { setPlaylists((items) => items.map((item) => item.id === modal.playlistId ? { ...item, name } : item)); setModal(null); }); }}><h2>给歌单，一个新名字</h2><p>歌曲与排列顺序都会保留。</p><label className="form-field">歌单名称<input value={newPlaylistName} maxLength={60} aria-invalid={Boolean(playlistError)} aria-describedby={playlistError ? "rename-error" : undefined} onChange={(event) => { setNewPlaylistName(event.target.value); setPlaylistError(""); }} /></label>{playlistError && <p className="form-error" id="rename-error" role="alert">{playlistError}</p>}<div className="dialog-actions"><button type="button" className="button subtle" onClick={closeDialog}>取消</button><button className="button primary" type="submit">保存名称</button></div></form>}
      {modal.type === "delete" && <><h2>删除这张歌单？</h2><p>「{playlists.find((item) => item.id === modal.playlistId)?.name}」会从私人歌单中移除。曲库中的音乐文件和收藏不会被删除。</p><div className="dialog-actions"><button className="button subtle" onClick={closeDialog}>保留歌单</button><button className="button danger" onClick={() => saveChange("删除歌单", () => { setPlaylists((items) => items.filter((item) => item.id !== modal.playlistId)); setOrderDraft(null); setModal(null); navigate("playlists"); })}><Trash2 />删除歌单</button></div></>}
      {modal.type === "create" && <form onSubmit={(event) => { event.preventDefault(); createPlaylist(); }}><h2>给心情，一张歌单</h2><p>装下某个时刻，也收藏某种喜欢。</p><label className="form-field">歌单名称<input autoFocus value={newPlaylistName} maxLength={60} placeholder="比如：星期天的午后" aria-invalid={Boolean(playlistError)} aria-describedby={playlistError ? "playlist-error" : undefined} onChange={(event) => { setNewPlaylistName(event.target.value); setPlaylistError(""); }} /></label>{playlistError && <p className="form-error" id="playlist-error" role="alert">{playlistError}</p>}<div className="dialog-actions"><button type="button" className="button subtle" onClick={() => setModal(null)}>再想想</button><button type="submit" className="button primary"><Plus /> 创建歌单</button></div></form>}
      {modal.type === "add" && <><h2>收藏到哪张歌单？</h2><p>{displayTitle(trackMap.get(modal.trackId)!)}</p><div className="add-playlist-list">{playlists.map((playlist) => <button key={playlist.id} onClick={() => addToPlaylist(playlist.id, modal.trackId)}><PlaylistArt playlist={playlist} /><span><strong>{playlist.name}</strong><small>{playlist.trackIds.length} 首歌曲</small></span>{playlist.trackIds.includes(modal.trackId) ? <Check /> : <Plus />}</button>)}</div>{!playlists.length && <p className="muted-copy">还没有歌单，先为这些旋律建一张吧。</p>}<button className="button subtle full-width" onClick={() => { setNewPlaylistName(""); setPlaylistError(""); setModal({ type: "create", trackId: modal.trackId }); }}><Plus /> 创建新歌单</button></>}
      {modal.type === "playlist-add" && (() => {
        const playlist = playlists.find((item) => item.id === modal.playlistId);
        if (!playlist) return null;
        const term = playlistTrackQuery.trim().toLocaleLowerCase();
        const available = tracks.filter((track) => !playlist.trackIds.includes(track.id) && `${displayTitle(track)} ${track.artist} ${albumMap.get(track.albumId)?.name ?? ""}`.toLocaleLowerCase().includes(term)).slice(0, 60);
        return <><h2>添加歌曲</h2><p>从曲库挑选歌曲，加入「{playlist.name}」。</p><label className="form-field playlist-track-search">搜索歌曲<input autoFocus value={playlistTrackQuery} placeholder="输入歌曲、艺人或专辑" aria-label="搜索要添加的歌曲" onChange={(event) => setPlaylistTrackQuery(event.target.value)} /></label><div className="add-playlist-list track-picker-list">{available.map((track) => <button key={track.id} onClick={() => addToPlaylist(playlist.id, track.id)}><Cover className="playlist-track-cover" album={albumMap.get(track.albumId)!} /><span><strong>{displayTitle(track)}</strong><small>{track.artist} · {albumMap.get(track.albumId)?.name}</small></span><Plus /></button>)}{!available.length && <div className="picker-empty"><Music2 /><span>{!tracks.length ? "曲库还没有歌曲，先连接音乐目录吧。" : term ? "没有匹配的未添加歌曲" : "这个歌单已经收下曲库里的歌曲了"}</span></div>}</div></>;
      })()}
      {modal.type === "info" && <><span className="eyebrow">MUSIC LIBRARY · DESIGN CONCEPT 01</span><h2>属于你的，私人音乐空间</h2><p>以唱片收藏为灵感，让浏览、发现与聆听都慢下来。</p><div className="about-stats"><span><strong>{tracks.length.toLocaleString()}</strong>首歌曲</span><span><strong>{albums.length}</strong>张真实专辑</span><span><strong>01</strong>私人音乐室</span></div><div className="prototype-explanation"><Info /><p>这是独立交互原型，使用本地曲库的元数据与封面快照。常规播放为交互演示；氛围模式可播放配置目录中的真实音乐，并根据声音编排灯光。未配置曲库时使用标注的原创演示音源。收藏和歌单在刷新后重置。原曲库与现有应用保持不变。</p></div><button className="button primary full-width" onClick={() => setModal(null)}>开始逛逛 <ArrowRight /></button></>}
      {modal.type === "directory" && <>
        <h2>选择音乐目录</h2>
        <p>选择一个本地或 NAS 挂载目录，开听会以只读方式扫描其中的音乐文件。</p>
        <div className="directory-picker" role="listbox" aria-label="可用音乐目录">
          <div className="directory-picker-heading"><span>可用目录</span><span>只读</span></div>
          {directoryOptions.map((option) => <button type="button" role="option" aria-selected={directorySelection === option.path} aria-disabled={!option.available} className={`directory-option ${directorySelection === option.path ? "is-selected" : ""} ${!option.available ? "is-unavailable" : ""}`} key={option.path} disabled={!option.available} onClick={() => setDirectorySelection(option.path)}><span className="directory-option-icon"><FolderOpen aria-hidden="true" /></span><span><strong>{option.path}</strong><small>{option.detail}</small></span>{directorySelection === option.path && <Check aria-hidden="true" />}</button>)}
        </div>
        <div className="prototype-explanation"><Info /><p>原型预览使用静态目录示意。正式接入后，这里会打开系统目录选择器并显示实际挂载状态。</p></div>
        <div className="dialog-actions"><button type="button" className="button subtle" onClick={() => setModal(modal.returnTo === "settings" ? { type: "settings" } : null)}>取消</button><button type="button" className="button primary" disabled={!directoryOptions.find((option) => option.path === directorySelection)?.available} onClick={() => startDirectoryScan(directorySelection)}>选择此目录</button></div>
      </>}
      {modal.type === "scan-failures" && <>
        <h2>扫描失败详情</h2>
        <p>以下文件没有进入当前曲库快照。修复目录连接或权限后，可以重新扫描。</p>
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
          {scan.status !== "idle" && scan.status !== "running" && <button className="settings-scan-result" onClick={() => { setModal(null); navigate("scan"); }}>{scan.status === "complete" ? "上次扫描已全部完成" : scan.status === "empty" ? "上次扫描未发现音乐" : scan.status === "partial" ? "上次扫描有 3 个文件需要处理" : "上次扫描未完成"}<span>查看结果 <ChevronRight /></span></button>}
        </div>
        : <div className="directory-setting"><div className="directory-setting-heading"><span><strong>共享音乐库</strong><small>音乐目录与扫描由管理员维护，你可以自由浏览和聆听。</small></span><span className="setting-badge">只读聆听</span></div></div>}
        <div className="setting-row"><span><strong>紧凑歌曲列表</strong><small>在同一屏里看见更多音乐</small></span><button className={`toggle ${dense ? "on" : ""}`} role="switch" aria-checked={dense} aria-label="紧凑歌曲列表" onClick={() => setDense((value) => !value)}><span /></button></div>
        <div className="setting-row"><span><strong>深色主题</strong><small>降低环境光下的亮度，保留红色强调</small></span><button className={`toggle ${darkMode ? "on" : ""}`} role="switch" aria-checked={darkMode} aria-label="深色主题" onClick={() => setDarkMode((value) => !value)}><span /></button></div>
        <div className="setting-row"><span><strong>曲库快照</strong><small>{directoryUnavailable ? "目录恢复后才能读取快照" : initialSetup ? "选择目录并完成扫描后生成" : scan.status === "running" && libraryMode !== "ready" ? "正在准备首份曲库快照" : libraryDirectoryNeedsScan ? "等待目录扫描后建立快照" : partialScan ? `已载入 ${tracks.length.toLocaleString()} 首歌曲 · 仍有 ${scanFailures.length} 个文件失败` : `${tracks.length.toLocaleString()} 首歌曲 · ${albums.length} 张专辑`}</small></span><span className={`setting-badge ${directoryUnavailable ? "is-error" : initialSetup || libraryDirectoryNeedsScan || partialScan ? "is-pending" : ""}`}>{directoryUnavailable ? "不可用" : initialSetup ? "未生成" : scan.status === "running" && libraryMode !== "ready" ? "生成中" : libraryDirectoryNeedsScan ? "待生成" : partialScan ? "部分" : "已载入"}</span></div>
        <div className="setting-row"><span><strong>设计状态预览</strong><small>查看空态、异常与完整交互流程</small></span><button className="text-button" onClick={() => { setModal(null); navigate("preview"); }}>查看全部<ChevronRight /></button></div>
        <div className="prototype-explanation"><Info /><p>当前为独立交互演示，扫描和登录使用模拟状态。配置本地曲库后，播放器只读播放真实音乐；未配置时使用明确标注的原创演示音源。音乐文件不会被修改。</p></div>
        <button className="button primary full-width" onClick={() => setModal(null)}>就这样，很好</button>
      </>}
    </fieldset>{renderWriteFeedback()}</Modal>}
    {menu && <><button className="menu-backdrop" aria-label="关闭歌曲操作菜单" onClick={() => setMenu(null)} /><div className="track-menu" role="menu" aria-label="歌曲操作" style={{ left: Math.max(12, menu.x), top: Math.max(12, menu.y) }}><button role="menuitem" autoFocus onClick={() => enqueue(menu.track, true)}><SkipForward /> 下一首播放</button><button role="menuitem" onClick={() => enqueue(menu.track)}><ListMusic /> 加入待播清单</button><button role="menuitem" onClick={() => { setModal({ type: "add", trackId: menu.track.id }); setMenu(null); }}><Plus /> 添加到歌单</button><button role="menuitem" onClick={() => { toggleFavorite(menu.track.id); setMenu(null); }}><Heart />{favorites.has(menu.track.id) ? "取消收藏" : "收藏歌曲"}</button><button role="menuitem" onClick={() => navigate(`album/${menu.track.albumId}`)}><Disc3 /> 前往专辑</button></div></>}
    <div className={`toast ${toast ? "visible" : ""}`} role="status" aria-live="polite">{toast && <><Check size={16} />{toast}</>}</div>
  </div></>;
}
