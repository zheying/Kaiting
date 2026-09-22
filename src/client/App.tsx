import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  Album as AlbumIcon,
  ChevronDown,
  Disc3,
  Heart,
  Library,
  ListMusic,
  Loader2,
  LogOut,
  Maximize2,
  MessageSquare,
  MessageSquareOff,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  SkipBack,
  SkipForward,
  Sparkles,
  UserRound,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import { api, artworkUrl, streamUrl, type ScanOptions } from "./api.js";
import { createLatestRequest, playbackErrorMessage, scanJustFinished, type PlaybackStatus } from "./async-state.js";
import { useLibraryPage } from "./library-pages.js";
import { useSeekInput } from "./seek-input.js";
import { PlaylistView } from "./PlaylistView.js";
import { createPlaylistMutationLock, createTrackPlaylistAdder } from "./playlist-state.js";
import type { Album, Artist, LibrarySummary, MetadataStatus, Playlist, ScanError, ScanJob, Page, Track } from "../shared/types.js";

type View =
  | { name: "home" }
  | { name: "search"; q: string }
  | { name: "albums" }
  | { name: "artists" }
  | { name: "favorites" }
  | { name: "playlists" }
  | { name: "playing" }
  | { name: "album"; key: string }
  | { name: "artist"; nameValue: string }
  | { name: "playlist"; id: string };

const VIEW_HISTORY_KEY = "__nasMusicLibraryView";
const PLAYER_STORAGE_KEY = "nas-music-library-player";
const VOLUME_STORAGE_KEY = "nas-music-library-volume";
const MOBILE_FULLSCREEN_CLOSE_MS = 360;

interface ViewHistoryState {
  [VIEW_HISTORY_KEY]: "base" | "view";
  view: View;
}

interface StoredPlayerState {
  current: Track;
  queue: Track[];
  playing: boolean;
  position: number;
  updatedAt: number;
}

interface SeekRequest {
  id: number;
  position: number;
}

type RepeatMode = "off" | "one" | "all";
type LyricsStatus = "idle" | "loading" | "ready" | "unavailable" | "error";

interface LyricLine {
  text: string;
  time: number | null;
}

interface LyricsCacheEntry {
  status: LyricsStatus;
  lines: LyricLine[];
}

declare global {
  interface Window {
    __nasMusicPlayTrack?: (trackId: string) => void;
    __nasMusicResume?: () => void;
    __nasMusicRetry?: () => void;
  }
}

function homeView(): View {
  return { name: "home" };
}

function isView(value: unknown): value is View {
  if (!value || typeof value !== "object") return false;
  const view = value as Record<string, unknown>;
  if (["home", "albums", "artists", "favorites", "playlists", "playing"].includes(String(view.name))) return true;
  if (view.name === "search") return typeof view.q === "string";
  if (view.name === "album") return typeof view.key === "string";
  if (view.name === "artist") return typeof view.nameValue === "string";
  if (view.name === "playlist") return typeof view.id === "string";
  return false;
}

function viewFromHash(): View {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash) return homeView();
  const [name, value = ""] = hash.split("/");
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return homeView(); }
  if (name === "search") return { name: "search", q: decoded };
  if (name === "albums") return { name: "albums" };
  if (name === "artists") return { name: "artists" };
  if (name === "favorites") return { name: "favorites" };
  if (name === "playlists") return { name: "playlists" };
  if (name === "playing") return { name: "playing" };
  if (name === "album" && decoded) return { name: "album", key: decoded };
  if (name === "artist" && decoded) return { name: "artist", nameValue: decoded };
  if (name === "playlist" && decoded) return { name: "playlist", id: decoded };
  return homeView();
}

function viewUrl(view: View): string {
  const base = window.location.pathname;
  if (view.name === "home") return base;
  if (view.name === "search") return `${base}#/search/${encodeURIComponent(view.q)}`;
  if (view.name === "album") return `${base}#/album/${encodeURIComponent(view.key)}`;
  if (view.name === "artist") return `${base}#/artist/${encodeURIComponent(view.nameValue)}`;
  if (view.name === "playlist") return `${base}#/playlist/${encodeURIComponent(view.id)}`;
  return `${base}#/${view.name}`;
}

function viewHistoryState(view: View, kind: ViewHistoryState[typeof VIEW_HISTORY_KEY]): ViewHistoryState {
  return { [VIEW_HISTORY_KEY]: kind, view };
}

function isMobileBrowserUA() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad/i.test(ua)) return false;
  return /iPhone|iPod|Android.+Mobile|Windows Phone|Mobi/i.test(ua);
}

function sameView(left: View, right: View): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readStoredPlayer(): StoredPlayerState | null {
  try {
    const raw = window.sessionStorage.getItem(PLAYER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPlayerState;
    return parsed?.current?.id ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredPlayer(state: StoredPlayerState): void {
  try {
    window.sessionStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A full library can exceed the browser quota. Keep playback running and
    // discard the stale snapshot so a refresh cannot restore an older queue.
    try { window.sessionStorage.removeItem(PLAYER_STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
  }
}

function readStoredVolume(): number {
  const raw = window.localStorage.getItem(VOLUME_STORAGE_KEY);
  if (!raw) return 0.8;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 1)) : 0.8;
}

function writeStoredVolume(volume: number): void {
  window.localStorage.setItem(VOLUME_STORAGE_KEY, String(volume));
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds) return "0:00";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function formatHours(seconds: number): string {
  if (!seconds) return "0 分钟";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

function formatRemaining(position: number, duration: number | null | undefined): string {
  const remaining = Math.max(0, (duration ?? 0) - position);
  return `-${formatDuration(remaining)}`;
}

function repeatModeTitle(mode: RepeatMode): string {
  if (mode === "one") return "单曲循环";
  if (mode === "all") return "列表循环";
  return "正常模式";
}

function PlayerShuffleIcon() {
  return (
    <svg className="apple-mode-icon" width="32" height="28" viewBox="0 0 32 28" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M20.767 20.44a.81.81 0 00.49-.183l2.58-2.174c.316-.266.316-.681 0-.955l-2.58-2.183a.81.81 0 00-.49-.183c-.415 0-.673.258-.673.673v1.245h-1.162c-.739 0-1.195-.233-1.718-.847l-1.527-1.801 1.527-1.81c.54-.63.946-.847 1.677-.847h1.203v1.279c0 .407.258.664.673.664a.801.801 0 00.49-.174l2.58-2.175c.316-.266.316-.69 0-.955l-2.58-2.183a.761.761 0 00-.49-.183c-.415 0-.673.258-.673.665v1.386h-1.212c-1.228 0-1.992.34-2.863 1.386l-1.412 1.668-1.469-1.751c-.805-.946-1.569-1.303-2.747-1.303H8.896c-.53 0-.896.348-.896.838s.365.838.896.838h1.437c.697 0 1.162.225 1.685.847l1.519 1.801-1.52 1.81c-.53.623-.954.847-1.643.847H8.896c-.53 0-.896.348-.896.838s.365.838.896.838h1.536c1.179 0 1.901-.356 2.706-1.303l1.478-1.751 1.444 1.718c.822.98 1.627 1.336 2.822 1.336h1.212v1.412c0 .415.258.672.673.672z" />
    </svg>
  );
}

function PlayerRepeatIcon() {
  return (
    <svg className="apple-mode-icon" width="32" height="28" viewBox="0 0 32 28" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M9.545 14.272a.856.856 0 00.863-.855v-.448c0-1.004.706-1.677 1.785-1.677h5.005v1.362c0 .407.258.664.673.664a.745.745 0 00.49-.183l2.581-2.166c.316-.266.316-.69 0-.955l-2.581-2.183a.745.745 0 00-.49-.183c-.415 0-.672.258-.672.665v1.294h-4.881c-2.217 0-3.628 1.254-3.628 3.213v.597c0 .474.382.855.855.855zm4.864 5.952c.407 0 .664-.257.664-.664v-1.303h4.881c2.225 0 3.628-1.254 3.628-3.213v-.597a.854.854 0 10-1.71 0v.448c0 1.004-.714 1.677-1.793 1.677h-5.006v-1.353c0-.407-.257-.664-.664-.664a.767.767 0 00-.498.182l-2.573 2.175c-.324.257-.315.68 0 .946l2.573 2.192a.807.807 0 00.498.174z" />
    </svg>
  );
}

function PlayerRepeatOneIcon() {
  return (
    <svg className="apple-mode-icon" width="32" height="28" viewBox="0 0 32 28" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M22.752 12.313c.473 0 .747-.257.747-.771V8.503c0-.54-.357-.904-.888-.904-.44 0-.698.14-1.038.398l-.838.656c-.2.15-.266.299-.266.473 0 .257.19.465.498.465.133 0 .24-.042.349-.125l.614-.514h.058v2.59c0 .514.274.771.764.771zm-13.207 1.96a.84.84 0 00.863-.856v-.448c0-1.004.706-1.677 1.785-1.677h3.403v1.362c0 .407.258.664.673.664a.745.745 0 00.49-.183l2.581-2.166c.316-.266.316-.69 0-.955L16.76 7.831a.745.745 0 00-.49-.183c-.415 0-.673.258-.673.665v1.294h-3.278c-2.217 0-3.628 1.254-3.628 3.213v.597c0 .49.374.855.855.855zm4.864 5.951c.407 0 .664-.257.664-.664v-1.303h4.881c2.225 0 3.628-1.254 3.628-3.213v-.597a.838.838 0 00-.855-.855.833.833 0 00-.855.855v.448c0 1.004-.714 1.677-1.793 1.677h-5.006v-1.353c0-.407-.257-.664-.664-.664a.767.767 0 00-.498.182l-2.573 2.175c-.324.257-.315.68 0 .946l2.573 2.192a.807.807 0 00.498.174z" />
    </svg>
  );
}

function PlayerVolumeIcon({ level, muted = false }: { level: 1 | 2 | 3; muted?: boolean }) {
  return (
    <svg className="player-volume-icon" width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M4.25 11.1h4.4l5.25-4.55c.62-.54 1.6-.1 1.6.72v13.46c0 .82-.98 1.26-1.6.72L8.65 16.9h-4.4c-.55 0-1-.45-1-1v-3.8c0-.55.45-1 1-1z" fill="currentColor" />
      {muted ? (
        <>
          <path d="M18.75 11.15l5 5" />
          <path d="M23.75 11.15l-5 5" />
        </>
      ) : (
        <>
          {level >= 1 ? <path d="M18.05 11.5c.9 1.42.9 3.58 0 5" /> : null}
          {level >= 2 ? <path d="M20.6 9.05c2.05 2.68 2.05 7.22 0 9.9" /> : null}
          {level >= 3 ? <path d="M23.15 6.65c3.23 4.38 3.23 10.32 0 14.7" /> : null}
        </>
      )}
    </svg>
  );
}

function parseLyrics(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const timestampPattern = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  for (const rawLine of text.split(/\r?\n/)) {
    const timestamps = [...rawLine.matchAll(timestampPattern)].map((match) => {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
      return minutes * 60 + seconds + fraction;
    });
    const lyricText = rawLine.replace(/\[[^\]]+\]/g, "").trim();
    if (!lyricText) continue;
    if (timestamps.length === 0) {
      lines.push({ text: lyricText, time: null });
      continue;
    }
    for (const time of timestamps) lines.push({ text: lyricText, time });
  }

  return lines.sort((left, right) => (left.time ?? Number.MAX_SAFE_INTEGER) - (right.time ?? Number.MAX_SAFE_INTEGER));
}

function activeLyricIndex(lines: LyricLine[], position: number): number {
  let active = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const time = lines[index].time;
    if (time === null) continue;
    if (time > position) break;
    active = index;
  }
  return active;
}

function usesTranscodedStream(track: Pick<Track, "path" | "codec" | "container" | "formatGroup">): boolean {
  const lowerPath = track.path.toLowerCase();
  const codec = (track.codec ?? "").toLowerCase();
  const container = (track.container ?? "").toLowerCase();
  const formatGroup = track.formatGroup.toLowerCase();
  const isAlac = formatGroup === "alac" || codec.includes("alac") || codec.includes("apple lossless") || container.includes("apple lossless");
  if ((lowerPath.endsWith(".m4a") || lowerPath.endsWith(".alac")) && isAlac) return true;
  if (lowerPath.endsWith(".flac") || lowerPath.endsWith(".alac")) return true;
  return !(
    lowerPath.endsWith(".mp3") ||
    lowerPath.endsWith(".m4a") ||
    lowerPath.endsWith(".aac") ||
    lowerPath.endsWith(".ogg") ||
    lowerPath.endsWith(".opus") ||
    lowerPath.endsWith(".wav")
  );
}

function Cover({ trackId, title, large = false }: { trackId?: string | null; title: string; large?: boolean }) {
  return (
    <div className={large ? "cover cover-large" : "cover"}>
      {trackId ? <img src={artworkUrl(trackId)} alt={title} /> : <Music2 aria-hidden="true" />}
    </div>
  );
}

function Equalizer({ paused = false }: { paused?: boolean }) {
  return (
    <span className={paused ? "equalizer paused" : "equalizer"} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api.login(password);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-mark">
          <Disc3 />
        </div>
        <h1>Music Library</h1>
        <p>连接你的 NAS 曲库。</p>
        <label>
          <span>管理密码</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
        </label>
        {error ? <div className="error">{error}</div> : null}
        <button className="primary" disabled={loading}>
          {loading ? <Loader2 className="spin" /> : <Play />}
          登录
        </button>
      </form>
    </main>
  );
}

function StatBar({ summary }: { summary: LibrarySummary | null }) {
  const stats = [
    ["歌曲", summary?.trackCount ?? 0],
    ["专辑", summary?.albumCount ?? 0],
    ["艺人", summary?.artistCount ?? 0],
    ["收藏", summary?.favoriteCount ?? 0]
  ];
  return (
    <div className="stat-bar">
      {stats.map(([label, value]) => (
        <div key={label}>
          <strong>{value}</strong>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

function TrackRow({
  track,
  index,
  active,
  playing,
  playlists,
  onPlay,
  onAddToPlaylist,
  onCreatePlaylist,
  onFavorite,
  onRemove,
  playlistBusy = false,
  hideAlbum = false
}: {
  track: Track;
  index?: number;
  active: boolean;
  playing: boolean;
  playlists: Playlist[];
  onPlay: (track: Track) => void;
  onAddToPlaylist: (playlistId: string, track: Track) => Promise<void>;
  onCreatePlaylist: (name: string, track: Track) => Promise<void>;
  onFavorite: (track: Track) => void;
  onRemove?: () => Promise<void>;
  playlistBusy?: boolean;
  hideAlbum?: boolean;
}) {
  const activePlaying = active && playing;
  const [menuOpen, setMenuOpen] = useState(false);
  const [playlistMenuOpen, setPlaylistMenuOpen] = useState(false);
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [newPlaylistError, setNewPlaylistError] = useState("");
  const [playlistMenuBusy, setPlaylistMenuBusy] = useState(false);
  const playlistMenuPending = useRef(false);
  const [menuPlacement, setMenuPlacement] = useState<"down" | "up">("down");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
      setPlaylistMenuOpen(false);
      setCreatingPlaylist(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      setPlaylistMenuOpen(false);
      setCreatingPlaylist(false);
      menuButtonRef.current?.focus();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  async function runPlaylistMenuAction(operation: () => Promise<void>) {
    if (playlistMenuPending.current || playlistBusy) return;
    playlistMenuPending.current = true;
    setPlaylistMenuBusy(true);
    setNewPlaylistError("");
    try {
      await operation();
      setNewPlaylistName("");
      setCreatingPlaylist(false);
      setPlaylistMenuOpen(false);
      setMenuOpen(false);
    } catch (error) {
      setNewPlaylistError(error instanceof Error ? error.message : "操作失败，请重试。");
    } finally {
      playlistMenuPending.current = false;
      setPlaylistMenuBusy(false);
    }
  }

  async function createPlaylistFromMenu() {
    const name = newPlaylistName.trim();
    if (!name) { setNewPlaylistError("请输入歌单名称"); return; }
    await runPlaylistMenuAction(() => onCreatePlaylist(name, track));
  }

  function addToPlaylist(playlistId: string) {
    void runPlaylistMenuAction(() => onAddToPlaylist(playlistId, track));
  }

  function toggleMenu() {
    if (menuOpen) {
      setMenuOpen(false);
      setPlaylistMenuOpen(false);
      setCreatingPlaylist(false);
      return;
    }
    const rect = menuButtonRef.current?.getBoundingClientRect();
    if (rect) {
      const playerTop = document.querySelector(".player")?.getBoundingClientRect().top ?? window.innerHeight;
      const spaceBelow = playerTop - rect.bottom;
      const spaceAbove = rect.top;
      setMenuPlacement(spaceBelow < 470 && spaceAbove > spaceBelow ? "up" : "down");
    }
    setMenuOpen(true);
  }

  return (
    <div className={`track-row${active ? " active" : ""}${hideAlbum ? " hide-album" : ""}`}>
      <button className={active ? "icon-button now-button" : "icon-button"} title={activePlaying ? "正在播放" : active ? "已暂停" : "播放"} aria-label={`播放《${track.title}》${activePlaying ? "，正在播放" : ""}`} onClick={() => onPlay(track)}>
        {active ? <Equalizer paused={!playing} /> : <Play />}
      </button>
      <span className="track-index">{index ?? ""}</span>
      <div className="track-main">
        <strong title={track.title}>{track.title}</strong>
        <span>{track.artist ?? "未知艺人"}</span>
      </div>
      {!hideAlbum ? <span className="track-album" title={track.album ?? "未知专辑"}>{track.album ?? "未知专辑"}</span> : null}
      <span className="track-codec">{track.formatGroup.toUpperCase()}</span>
      <span>{formatDuration(track.duration)}</span>
      <div className={`track-menu-wrap ${menuPlacement === "up" ? "open-up" : "open-down"}`} ref={menuRef}>
        <button ref={menuButtonRef} className="icon-button track-menu-button" title="更多" aria-label={`《${track.title}》的更多操作`} aria-expanded={menuOpen} onClick={toggleMenu}>
          <MoreHorizontal />
        </button>
        {menuOpen ? (
          <div className="track-menu">
            <div className="menu-nested">
              <button type="button" disabled={playlistMenuBusy || playlistBusy} onClick={() => setPlaylistMenuOpen((value) => !value)}>
                <span>添加到歌单</span>
                <ListMusic />
              </button>
              {playlistMenuOpen ? (
                <div className="track-submenu">
                  <button disabled={playlistMenuBusy || playlistBusy} className="submenu-create-trigger" onClick={() => setCreatingPlaylist((value) => !value)}>
                    <span>新歌单</span>
                    <Plus />
                  </button>
                  {creatingPlaylist ? (
                    <div className="submenu-create">
                      <input
                        value={newPlaylistName}
                        disabled={playlistMenuBusy || playlistBusy}
                        maxLength={200}
                        onChange={(event) => {
                          setNewPlaylistName(event.currentTarget.value);
                          setNewPlaylistError("");
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void createPlaylistFromMenu();
                        }}
                        placeholder="歌单名称"
                        autoFocus
                      />
                      <button disabled={playlistMenuBusy || playlistBusy} onClick={() => void createPlaylistFromMenu()}>{playlistMenuBusy ? "处理中…" : "创建并添加"}</button>
                    </div>
                  ) : null}
                  {playlists.length > 0 ? playlists.map((playlist) => (
                    <button key={playlist.id} disabled={playlistMenuBusy || playlistBusy} onClick={() => addToPlaylist(playlist.id)}>
                      <span>{playlist.name}</span>
                    </button>
                  )) : (
                    <button disabled>
                      <span>暂无歌单</span>
                    </button>
                  )}
                </div>
              ) : null}
            </div>
            {playlistMenuBusy ? <p className="playlist-menu-status" role="status">正在更新歌单…</p> : null}
            {newPlaylistError ? <p className="playlist-menu-error" role="alert">{newPlaylistError} 请再次点击操作按钮重试。</p> : null}
            {onRemove ? <button type="button" disabled={playlistMenuBusy || playlistBusy} className="danger-action" onClick={() => void runPlaylistMenuAction(onRemove)}><span>从此歌单移除</span><X /></button> : null}
            <button className={track.favorite ? "heart-on" : ""} onClick={() => { onFavorite(track); setPlaylistMenuOpen(false); setMenuOpen(false); }}>
              <span>{track.favorite ? "取消收藏" : "个人收藏"}</span>
              <Heart />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AlbumGrid({ albums, onOpen }: { albums: Album[]; onOpen: (album: Album) => void }) {
  return (
    <div className="grid">
      {albums.map((album) => (
        <button className="album-tile" key={album.key} onClick={() => onOpen(album)}>
          <Cover trackId={album.artworkTrackId} title={album.title} />
          <strong title={album.title}>{album.title}</strong>
          <span title={album.artist ?? "未知艺人"}>{album.artist ?? "未知艺人"}</span>
          <small className="album-meta">{album.year ? `${album.year} · ` : ""}{album.trackCount} 首</small>
        </button>
      ))}
    </div>
  );
}

function ArtistList({ artists, onOpen }: { artists: Artist[]; onOpen: (artist: Artist) => void }) {
  return (
    <div className="artist-list">
      {artists.map((artist) => (
        <button key={artist.name} onClick={() => onOpen(artist)}>
          <Cover trackId={artist.artworkTrackId} title={artist.name} />
          <div>
            <strong>{artist.name}</strong>
            <span>{artist.albumCount} 张专辑 · {artist.trackCount} 首歌</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function Player({
  current,
  queue,
  playing,
  initialPosition,
  seekRequest,
  onPlaybackStatusChange,
  volume,
  muted,
  onProgressChange,
  onPlayingChange,
  onOpenAlbum,
  onOpenArtist,
  onOpenNowPlaying,
  onVolumeChange,
  onMutedChange,
  onPrevious,
  onNext,
  repeatMode,
  shuffleEnabled,
  onToggleRepeatMode,
  onToggleShuffle,
  onSelectQueueTrack,
  onClearUpcoming,
  onToggle,
  onEnded
}: {
  current: Track | null;
  queue: Track[];
  playing: boolean;
  initialPosition: number;
  seekRequest: SeekRequest | null;
  onPlaybackStatusChange: (status: PlaybackStatus) => void;
  volume: number;
  muted: boolean;
  onProgressChange: (position: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onOpenAlbum: (track: Track) => void;
  onOpenArtist: (track: Track) => void;
  onOpenNowPlaying: () => void;
  onVolumeChange: (volume: number) => void;
  onMutedChange: (muted: boolean) => void;
  onPrevious: () => void;
  onNext: () => void;
  repeatMode: RepeatMode;
  shuffleEnabled: boolean;
  onToggleRepeatMode: () => void;
  onToggleShuffle: () => void;
  onSelectQueueTrack: (track: Track) => void;
  onClearUpcoming: () => void;
  onToggle: () => void;
  onEnded: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const restoredTrackId = useRef<string | null>(null);
  const pendingDirectSeek = useRef(0);
  const streamOffsetRef = useRef(0);
  const playRequests = useRef(createLatestRequest());
  const playPending = useRef(false);
  const playIntent = useRef(playing);
  const activeTrackId = useRef<string | null>(null);
  const statusRef = useRef<PlaybackStatus>({ state: "idle" });
  const volumeControlRef = useRef<HTMLDivElement>(null);
  const queuePanelRef = useRef<HTMLElement>(null);
  const queueToggleRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState(0);
  const positionRef = useRef(position);
  positionRef.current = position;
  const [duration, setDuration] = useState(0);
  const seekInput = useSeekInput({ position, duration: Math.max(duration || current?.duration || 0, 1), trackId: current?.id, onSeek: seekTo });
  const seeking = seekInput.seeking;
  const [progressHover, setProgressHover] = useState(false);
  const [volumeExpanded, setVolumeExpanded] = useState(false);
  const [volumeDragging, setVolumeDragging] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queuePageOffset, setQueuePageOffset] = useState(0);
  useEffect(() => setQueuePageOffset(0), [current?.id, queue.length]);
  const displayArtist = current?.artist ?? current?.albumArtist ?? "未知艺人";
  const displayAlbum = current?.album ?? "未知专辑";
  const currentQueueIndex = current ? queue.findIndex((track) => track.id === current.id) : -1;
  const upcomingQueue = currentQueueIndex >= 0 ? queue.slice(currentQueueIndex + 1) : queue;
  const queuePage = { items: upcomingQueue.slice(queuePageOffset, queuePageOffset + 50), total: upcomingQueue.length, offset: queuePageOffset, limit: 50 };
  const effectiveVolume = muted ? 0 : volume;
  const volumePercent = Math.round(effectiveVolume * 100);
  const volumeLevel: 1 | 2 | 3 = effectiveVolume < 0.34 ? 1 : effectiveVolume < 0.68 ? 2 : 3;

  function updateStreamOffset(value: number) {
    streamOffsetRef.current = value;
  }

  function reportPlaybackStatus(status: PlaybackStatus) {
    statusRef.current = status;
    onPlaybackStatusChange(status);
  }

  function requestPlay(audio: HTMLAudioElement) {
    const request = playRequests.current.begin();
    playIntent.current = true;
    playPending.current = true;
    if (audio.paused || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
      reportPlaybackStatus({ state: "loading", message: "正在加载音频…" });
    }
    void audio.play()
      .then(() => {
        if (!request.isCurrent()) return;
        playPending.current = false;
        if (!audio.paused) {
          reportPlaybackStatus({ state: "playing" });
          onPlayingChange(true);
        }
      })
      .catch((error) => {
        if (!request.isCurrent()) return;
        playPending.current = false;
        playIntent.current = false;
        reportPlaybackStatus({ state: "error", message: playbackErrorMessage(error, audio.error?.code) });
        onPlayingChange(false);
      });
  }

  function replaceSource(audio: HTMLAudioElement, source: string) {
    playRequests.current.cancel();
    playPending.current = false;
    audio.src = source;
  }

  function retryPlayback() {
    const audio = audioRef.current;
    if (!audio || !current) return;
    const resumePosition = Math.max(0, positionRef.current);
    if (usesTranscodedStream(current)) {
      pendingDirectSeek.current = 0;
      updateStreamOffset(resumePosition);
      replaceSource(audio, streamUrl(current.id, resumePosition));
    } else {
      pendingDirectSeek.current = resumePosition;
      updateStreamOffset(0);
      replaceSource(audio, streamUrl(current.id));
    }
    audio.load();
    onPlayingChange(true);
    requestPlay(audio);
  }

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      playRequests.current.cancel();
      playPending.current = false;
      playIntent.current = false;
      audio?.pause();
    };
  }, []);

  useEffect(() => {
    function playTrackFromGesture(trackId: string) {
      const audio = audioRef.current;
      if (!audio) return;
      const nextSrc = streamUrl(trackId);
      // Keep this synchronous with the gesture for mobile autoplay policies.
      activeTrackId.current = trackId;
      replaceSource(audio, nextSrc);
      pendingDirectSeek.current = 0;
      setPosition(0);
      updateStreamOffset(0);
      onProgressChange(0);
      onPlayingChange(true);
      requestPlay(audio);
    }

    function resumeFromGesture() {
      const audio = audioRef.current;
      if (!audio || !current) return;
      if (statusRef.current.state === "error") {
        retryPlayback();
        return;
      }
      onPlayingChange(true);
      requestPlay(audio);
    }

    window.__nasMusicPlayTrack = playTrackFromGesture;
    window.__nasMusicResume = resumeFromGesture;
    window.__nasMusicRetry = retryPlayback;
    return () => {
      if (window.__nasMusicPlayTrack === playTrackFromGesture) delete window.__nasMusicPlayTrack;
      if (window.__nasMusicResume === resumeFromGesture) delete window.__nasMusicResume;
      if (window.__nasMusicRetry === retryPlayback) delete window.__nasMusicRetry;
    };
  }, [current?.id]);

  function handleTogglePlayback() {
    if (playing) {
      playRequests.current.cancel();
      playPending.current = false;
      playIntent.current = false;
      audioRef.current?.pause();
      onToggle();
      return;
    }
    const audio = audioRef.current;
    if (audio && current) {
      if (statusRef.current.state === "error") {
        retryPlayback();
        return;
      }
      onPlayingChange(true);
      requestPlay(audio);
      return;
    }
    onToggle();
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    setDuration(current.duration ?? 0);
    if (activeTrackId.current === current.id) return;
    activeTrackId.current = current.id;
    const restorePosition = restoredTrackId.current === current.id ? 0 : Math.max(0, initialPosition || 0);
    restoredTrackId.current = current.id;
    setPosition(restorePosition);
    if (usesTranscodedStream(current) && restorePosition > 0) {
      pendingDirectSeek.current = 0;
      updateStreamOffset(restorePosition);
      replaceSource(audio, streamUrl(current.id, restorePosition));
    } else {
      pendingDirectSeek.current = restorePosition;
      updateStreamOffset(0);
      replaceSource(audio, streamUrl(current.id));
    }
    reportPlaybackStatus(playing ? { state: "loading", message: "正在加载音频…" } : { state: "paused" });
    if (playing) requestPlay(audio);
  }, [current?.id]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    playIntent.current = playing;
    if (playing) {
      if (!playPending.current && audio.paused) requestPlay(audio);
    } else {
      playRequests.current.cancel();
      playPending.current = false;
      audio.pause();
      if (statusRef.current.state !== "error") reportPlaybackStatus({ state: "paused" });
    }
  }, [playing, current?.id]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = muted || volume === 0;
  }, [volume, muted, current]);

  useEffect(() => {
    if (seekRequest) seekTo(seekRequest.position);
  }, [seekRequest?.id]);

  useEffect(() => {
    if (!volumeDragging) return;
    function stopVolumeDrag() {
      setVolumeDragging(false);
      if (!volumeControlRef.current?.matches(":hover")) setVolumeExpanded(false);
    }
    window.addEventListener("pointerup", stopVolumeDrag);
    window.addEventListener("pointercancel", stopVolumeDrag);
    return () => {
      window.removeEventListener("pointerup", stopVolumeDrag);
      window.removeEventListener("pointercancel", stopVolumeDrag);
    };
  }, [volumeDragging]);

  useEffect(() => {
    if (!volumeExpanded && !volumeDragging) return;
    function closeVolumeOnOutside(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && !volumeControlRef.current?.contains(target)) {
        setVolumeExpanded(false);
      }
    }
    window.addEventListener("pointerdown", closeVolumeOnOutside, true);
    return () => window.removeEventListener("pointerdown", closeVolumeOnOutside, true);
  }, [volumeExpanded, volumeDragging]);

  useEffect(() => {
    if (!queueOpen) return;
    function closeQueueOnOutside(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (queuePanelRef.current?.contains(target) || target.closest(".queue-toggle-button")) return;
      setQueueOpen(false);
    }
    function closeQueueOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setQueueOpen(false);
        queueToggleRef.current?.focus();
      }
    }
    window.addEventListener("pointerdown", closeQueueOnOutside, true);
    window.addEventListener("keydown", closeQueueOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeQueueOnOutside, true);
      window.removeEventListener("keydown", closeQueueOnEscape);
    };
  }, [queueOpen]);

  function mediaPosition(audio: HTMLAudioElement): number {
    return Math.min(duration || current?.duration || Number.POSITIVE_INFINITY, streamOffsetRef.current + audio.currentTime);
  }

  function handleTimeUpdate() {
    const audio = audioRef.current;
    if (!audio || seeking || pendingDirectSeek.current > 0) return;
    const next = mediaPosition(audio);
    setPosition(next);
    onProgressChange(next);
  }

  function handleLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio) return;
    const nextDuration = current && usesTranscodedStream(current)
      ? current.duration ?? streamOffsetRef.current + (Number.isFinite(audio.duration) ? audio.duration : 0)
      : Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : current?.duration ?? 0;
    setDuration(nextDuration);
    if (pendingDirectSeek.current > 0) {
      const nextSeek = pendingDirectSeek.current;
      pendingDirectSeek.current = 0;
      try {
        audio.currentTime = nextSeek;
        updateStreamOffset(0);
        if (playing) requestPlay(audio);
      } catch {
        pendingDirectSeek.current = nextSeek;
      }
    }
  }

  function seekTo(value: number) {
    const audio = audioRef.current;
    if (!audio || !current) return;
    const maxDuration = duration || current.duration || value;
    const next = Math.max(0, Math.min(value, maxDuration));
    setPosition(next);
    onProgressChange(next);

    if (usesTranscodedStream(current)) {
      pendingDirectSeek.current = 0;
      updateStreamOffset(next);
      replaceSource(audio, streamUrl(current.id, next));
      if (playing) requestPlay(audio);
      return;
    }

    try {
      audio.currentTime = next;
      updateStreamOffset(0);
      if (playing) requestPlay(audio);
      return;
    } catch {
      // Fall back to reloading the direct stream and seeking after metadata is ready.
    }

    pendingDirectSeek.current = next;
    updateStreamOffset(0);
    replaceSource(audio, streamUrl(current.id));
    if (playing) requestPlay(audio);
  }

  function handlePause() {
    const audio = audioRef.current;
    // A queued pause from replacing src is obsolete once play() has resumed it.
    if (!audio?.paused || audio.ended) return;
    playRequests.current.cancel();
    playPending.current = false;
    playIntent.current = false;
    if (statusRef.current.state !== "error") reportPlaybackStatus({ state: "paused" });
    onPlayingChange(false);
  }

  function handleBuffering() {
    const audio = audioRef.current;
    if (playIntent.current && audio && !audio.error) {
      reportPlaybackStatus({ state: "buffering", message: "正在缓冲，若长时间无响应可重试。" });
    }
  }

  function handleMediaError() {
    const audio = audioRef.current;
    if (!audio?.error) return;
    playRequests.current.cancel();
    playPending.current = false;
    playIntent.current = false;
    reportPlaybackStatus({ state: "error", message: playbackErrorMessage(null, audio.error.code) });
    onPlayingChange(false);
  }

  function changeVolume(nextVolume: number) {
    const normalized = Math.max(0, Math.min(nextVolume, 1));
    onVolumeChange(normalized);
    onMutedChange(normalized === 0);
  }

  function toggleMuted() {
    if (muted || volume === 0) {
      onMutedChange(false);
      if (volume === 0) onVolumeChange(0.8);
      return;
    }
    onMutedChange(true);
  }

  const audioElement = (
    <audio
      ref={audioRef}
      onEnded={() => {
        playRequests.current.cancel();
        playPending.current = false;
        reportPlaybackStatus({ state: "paused" });
        onEnded();
      }}
      onLoadedMetadata={handleLoadedMetadata}
      onPause={handlePause}
      onPlaying={() => {
        const audio = audioRef.current;
        if (audio && !audio.paused && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
          reportPlaybackStatus({ state: "playing" });
          onPlayingChange(true);
        }
      }}
      onWaiting={handleBuffering}
      onStalled={handleBuffering}
      onError={handleMediaError}
      onTimeUpdate={handleTimeUpdate}
    />
  );

  if (!current) {
    return (
      <>
      {audioElement}
      <footer className="player empty-player">
        <div className="player-controls idle-controls" aria-hidden="true">
          <span className="player-mode-button"><PlayerShuffleIcon /></span>
          <span className="mini-transport-button"><SkipBack /></span>
          <span className="mini-play-button"><Play /></span>
          <span className="mini-transport-button"><SkipForward /></span>
          <span className="player-mode-button"><PlayerRepeatIcon /></span>
        </div>
        <div className="empty-player-brand" aria-label="Music Library">
          <Disc3 />
        </div>
        <div className="player-actions idle-actions" aria-hidden="true">
          <span className="player-utility-button"><MessageSquare /></span>
          <span className="player-utility-button"><ListMusic /></span>
          <span className="player-utility-button"><PlayerVolumeIcon level={3} /></span>
        </div>
      </footer>
      </>
    );
  }

  const playbackDuration = Math.max(duration || current.duration || 0, 1);
  const playbackPosition = seekInput.value;
  const progressPercent = (playbackPosition / playbackDuration) * 100;

  return (
    <>
    {audioElement}
    <footer className="player">
      <div className="player-controls">
        <button
          className={`player-mode-button ${shuffleEnabled ? "active" : ""}`}
          type="button"
          role="switch"
          aria-checked={shuffleEnabled}
          onClick={onToggleShuffle}
          title={shuffleEnabled ? "关闭乱序播放" : "打开乱序播放"}
        >
          <PlayerShuffleIcon />
        </button>
        <button className="mini-transport-button" type="button" onClick={onPrevious} title="上一首">
          <SkipBack />
        </button>
        <button className="mini-play-button" type="button" onClick={handleTogglePlayback} title={playing ? "暂停" : "播放"}>
          {playing ? <Pause /> : <Play />}
        </button>
        <button className="mini-transport-button" type="button" onClick={onNext} title="下一首">
          <SkipForward />
        </button>
        <button
          className={`player-mode-button ${repeatMode === "one" ? "repeat-one active" : repeatMode === "all" ? "repeat-all active" : ""}`}
          type="button"
          role="switch"
          aria-checked={repeatMode !== "off"}
          onClick={onToggleRepeatMode}
          title={repeatModeTitle(repeatMode)}
        >
          {repeatMode === "one" ? <PlayerRepeatOneIcon /> : <PlayerRepeatIcon />}
        </button>
      </div>

      <div className={`player-center ${progressHover || seeking ? "progress-active" : ""}`}>
        <button className="player-cover-button" onClick={onOpenNowPlaying} title="打开播放页">
          <Cover trackId={current.id} title={current.title} />
          <span className="cover-hover-hint" aria-hidden="true">
            <Maximize2 />
          </span>
        </button>
        <div className="now-playing">
          <strong title={current.title}>{current.title}</strong>
          <span className="now-links">
            <button title={displayArtist} onClick={() => onOpenArtist(current)}>{displayArtist}</button>
            <span aria-hidden="true"> - </span>
            <button title={displayAlbum} onClick={() => onOpenAlbum(current)}>{displayAlbum}</button>
            <span aria-hidden="true"> · 队列 {queue.length} 首</span>
          </span>
        </div>
        <span className="mini-progress-time current-time">{formatDuration(playbackPosition)}</span>
        <span className="mini-progress-time remaining-time">{formatRemaining(playbackPosition, duration || current.duration)}</span>
        <input
          className="mini-progress"
          style={{ "--progress": `${progressPercent}%` } as CSSProperties}
          aria-label="播放进度"
          type="range"
          min="0"
          max={playbackDuration}
          step="1"
          value={playbackPosition}
          {...seekInput.inputProps}
          onMouseEnter={() => setProgressHover(true)}
          onMouseLeave={() => setProgressHover(false)}
          onPointerEnter={() => setProgressHover(true)}
          onPointerLeave={() => setProgressHover(false)}
          onPointerDown={(event) => {
            setProgressHover(true);
            seekInput.inputProps.onPointerDown?.(event);
          }}
          onFocus={(event) => { setProgressHover(true); seekInput.inputProps.onFocus?.(event); }}
          onBlur={(event) => { setProgressHover(false); seekInput.inputProps.onBlur?.(event); }}
        />
      </div>

      <div className="player-actions">
        <button
          ref={queueToggleRef}
          className={`player-utility-button queue-toggle-button ${queueOpen ? "active" : ""}`}
          type="button"
          aria-expanded={queueOpen}
          onClick={() => setQueueOpen((value) => !value)}
          title="待播清单"
        >
          <ListMusic />
        </button>
        <div
          className={`volume-control ${volumeExpanded || volumeDragging ? "expanded" : ""}`}
          ref={volumeControlRef}
          onMouseEnter={() => setVolumeExpanded(true)}
          onMouseLeave={() => {
            if (!volumeDragging) setVolumeExpanded(false);
          }}
          onFocus={() => setVolumeExpanded(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setVolumeExpanded(false);
          }}
        >
          <button
            className="player-utility-button"
            type="button"
            onClick={() => {
              setVolumeExpanded(true);
              toggleMuted();
            }}
            title={muted || volume === 0 ? "恢复音量" : "静音"}
          >
            <PlayerVolumeIcon level={volumeLevel} muted={effectiveVolume <= 0} />
          </button>
          <input
            style={{ "--volume": `${volumePercent}%` } as CSSProperties}
            aria-label="音量"
            type="range"
            min="0"
            max="100"
            step="1"
            value={volumePercent}
            onPointerDown={() => {
              setVolumeExpanded(true);
              setVolumeDragging(true);
            }}
            onChange={(event) => changeVolume(Number(event.currentTarget.value) / 100)}
          />
        </div>
      </div>
    </footer>
    {queueOpen ? (
      <aside className="queue-drawer" ref={queuePanelRef} aria-label="待播清单">
        <header className="queue-drawer-header">
          <strong>待播清单</strong>
          <button
            className="queue-clear-button"
            type="button"
            onClick={onClearUpcoming}
            disabled={upcomingQueue.length === 0}
          >
            清除
          </button>
          <button className="icon-button queue-close-button" type="button" aria-label="关闭待播清单" onClick={() => { setQueueOpen(false); queueToggleRef.current?.focus(); }}><X /></button>
          <span className="queue-repeat-indicator" aria-label={repeatMode === "all" ? "列表循环" : "队列"}>
            {repeatMode === "all" ? "∞" : ""}
          </span>
        </header>
        {upcomingQueue.length > 0 ? (
          <div className="queue-list">
            {queuePage.items.map((track) => (
              <button
                className="queue-item"
                type="button"
                key={track.id}
                onClick={() => {
                  setQueueOpen(false);
                  onSelectQueueTrack(track);
                }}
              >
                <Cover trackId={track.id} title={track.title} />
                <span className="queue-item-text">
                  <strong title={track.title}>{track.title}</strong>
                  <span>{track.artist ?? track.albumArtist ?? "未知艺人"}</span>
                </span>
                <span className="queue-duration">{formatDuration(track.duration)}</span>
              </button>
            ))}
            <Pagination page={queuePage} loading={false} onChange={setQueuePageOffset} label="待播清单" />
          </div>
        ) : (
          <div className="queue-empty">没有待播歌曲</div>
        )}
      </aside>
    ) : null}
    </>
  );
}

function FullscreenPlayer({
  current,
  onlineMetadataEnabled,
  queue,
  isMobileShell,
  playing,
  position,
  repeatMode,
  shuffleEnabled,
  volume,
  muted,
  playlists,
  onAddToPlaylist,
  onClose,
  onCreatePlaylistForTrack,
  onFavorite,
  onNext,
  onOpenAlbum,
  onOpenArtist,
  onPrevious,
  onSeek,
  onSelectQueueTrack,
  onToggleRepeatMode,
  onToggleShuffle,
  onToggle,
  onToggleMuted,
  onVolumeChange
}: {
  current: Track | null;
  onlineMetadataEnabled: boolean;
  queue: Track[];
  isMobileShell: boolean;
  playing: boolean;
  position: number;
  repeatMode: RepeatMode;
  shuffleEnabled: boolean;
  volume: number;
  muted: boolean;
  playlists: Playlist[];
  onAddToPlaylist: (playlistId: string, track: Track) => Promise<void>;
  onClose: () => void;
  onCreatePlaylistForTrack: (name: string, track: Track) => Promise<void>;
  onFavorite: (track: Track) => void;
  onNext: () => void;
  onOpenAlbum: (track: Track) => void;
  onOpenArtist: (track: Track) => void;
  onPrevious: () => void;
  onSeek: (position: number) => void;
  onSelectQueueTrack: (track: Track) => void;
  onToggleRepeatMode: () => void;
  onToggleShuffle: () => void;
  onToggle: () => void;
  onToggleMuted: () => void;
  onVolumeChange: (volume: number) => void;
}) {
  const [lyricsCache, setLyricsCache] = useState<Record<string, LyricsCacheEntry>>({});
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [playlistMenuOpen, setPlaylistMenuOpen] = useState(false);
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [newPlaylistNameInline, setNewPlaylistNameInline] = useState("");
  const [newPlaylistError, setNewPlaylistError] = useState("");
  const [playlistMenuBusy, setPlaylistMenuBusy] = useState(false);
  const playlistMenuPending = useRef(false);
  const menuTrackId = useRef(current?.id);
  menuTrackId.current = current?.id;
  const duration = Math.max(current?.duration ?? 0, 1);
  const seekInput = useSeekInput({ position, duration, trackId: current?.id, onSeek });
  const [mobileQueueOpen, setMobileQueueOpen] = useState(false);
  const [queuePageOffset, setQueuePageOffset] = useState(0);
  useEffect(() => setQueuePageOffset(0), [current?.id, queue.length]);
  const [closing, setClosing] = useState(false);
  const closeTimeoutRef = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMenuOpen(false);
    setPlaylistMenuOpen(false);
    setCreatingPlaylist(false);
    setNewPlaylistNameInline("");
    setNewPlaylistError("");
    setMobileQueueOpen(false);
    setLyricsOpen(false);
  }, [current?.id]);

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current !== null) window.clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setMenuOpen(false);
      setPlaylistMenuOpen(false);
      setCreatingPlaylist(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      setPlaylistMenuOpen(false);
      setCreatingPlaylist(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  if (!current) return null;

  const displayPosition = seekInput.value;
  const displayArtist = current.artist ?? current.albumArtist ?? "未知艺人";
  const displayAlbum = current.album ?? "未知专辑";
  const background = artworkUrl(current.id);
  const currentQueueIndex = queue.findIndex((track) => track.id === current.id);
  const upcomingQueue = currentQueueIndex >= 0 ? queue.slice(currentQueueIndex + 1) : queue.filter((track) => track.id !== current.id);
  const queuePage = { items: upcomingQueue.slice(queuePageOffset, queuePageOffset + 50), total: upcomingQueue.length, offset: queuePageOffset, limit: 50 };
  const fullscreenClassName = [
    "fullscreen-player",
    playing ? "is-playing" : "is-paused",
    lyricsOpen ? "lyrics-open" : "",
    mobileQueueOpen ? "queue-open" : "",
    closing ? "is-closing" : ""
  ].filter(Boolean).join(" ");
  const progressStyle = { "--progress": `${(displayPosition / duration) * 100}%` } as CSSProperties;
  const lyricsEntry = lyricsCache[current.id] ?? { status: "idle", lines: [] };
  const lyricsStatus = lyricsEntry.status;
  const lyricsLines = lyricsEntry.lines;
  const hasSyncedLyrics = lyricsLines.some((line) => line.time !== null);
  const activeIndex = hasSyncedLyrics ? activeLyricIndex(lyricsLines, displayPosition) : -1;
  const lyricsSearchUnavailable = !current.hasLyrics && !onlineMetadataEnabled && lyricsStatus === "idle";
  const lyricsDisabled = lyricsStatus === "unavailable" || lyricsSearchUnavailable;
  const lyricsButtonClassName = [
    "fullscreen-lyrics-toggle",
    lyricsOpen ? "active" : "",
    lyricsDisabled ? "unavailable" : "",
    lyricsStatus === "loading" ? "lyrics-loading-state" : ""
  ].filter(Boolean).join(" ");

  async function runPlaylistMenuAction(track: Track, operation: () => Promise<void>) {
    if (playlistMenuPending.current) return;
    playlistMenuPending.current = true;
    setPlaylistMenuBusy(true);
    setNewPlaylistError("");
    try {
      await operation();
      if (menuTrackId.current !== track.id) return;
      setNewPlaylistNameInline("");
      setCreatingPlaylist(false);
      setPlaylistMenuOpen(false);
      setMenuOpen(false);
    } catch (error) {
      if (menuTrackId.current === track.id) setNewPlaylistError(error instanceof Error ? error.message : "操作失败，请重试。");
    } finally {
      playlistMenuPending.current = false;
      setPlaylistMenuBusy(false);
    }
  }

  async function createPlaylistFromMenu(track: Track) {
    const name = newPlaylistNameInline.trim();
    if (!name) { setNewPlaylistError("请输入歌单名称"); return; }
    await runPlaylistMenuAction(track, () => onCreatePlaylistForTrack(name, track));
  }

  function loadLyrics(track: Track) {
    setLyricsCache((cache) => ({
      ...cache,
      [track.id]: { status: "loading", lines: cache[track.id]?.lines ?? [] }
    }));
    api.lyrics(track.id, true)
      .then((text) => {
        const lines = parseLyrics(text);
        if (lines.length === 0) setLyricsOpen(false);
        setLyricsCache((cache) => ({
          ...cache,
          [track.id]: lines.length > 0 ? { status: "ready", lines } : { status: "unavailable", lines: [] }
        }));
      })
      .catch((error: unknown) => {
        const status = error instanceof Error && "status" in error ? (error as Error & { status?: number }).status : undefined;
        setLyricsCache((cache) => ({
          ...cache,
          [track.id]: { status: status === 404 ? "unavailable" : "error", lines: [] }
        }));
        setLyricsOpen(false);
      });
  }

  function toggleLyricsView() {
    if (!current) return;
    if (lyricsDisabled) return;
    if (lyricsOpen) {
      setLyricsOpen(false);
      return;
    }
    setMobileQueueOpen(false);
    setLyricsOpen(true);
    if (lyricsStatus === "idle" || lyricsStatus === "error") loadLyrics(current);
  }

  function handleClose() {
    if (!isMobileShell) {
      onClose();
      return;
    }
    if (closing) return;
    setClosing(true);
    closeTimeoutRef.current = window.setTimeout(() => {
      closeTimeoutRef.current = null;
      onClose();
    }, MOBILE_FULLSCREEN_CLOSE_MS);
  }

  return (
    <section className={fullscreenClassName} aria-label="播放页">
      {background ? <img className="fullscreen-bg" src={background} alt="" aria-hidden="true" /> : null}
      <div className="fullscreen-wash" />
      <button className="fullscreen-close" onClick={handleClose} title="关闭播放页">
        <X className="fullscreen-close-x" />
        <ChevronDown className="fullscreen-close-chevron" />
      </button>
      <button
        className={lyricsButtonClassName}
        type="button"
        disabled={lyricsDisabled}
        onClick={toggleLyricsView}
        aria-pressed={lyricsOpen}
        title={lyricsDisabled ? "暂无歌词" : lyricsOpen ? "隐藏歌词" : "显示歌词"}
      >
        <span className="lyrics-button-icon">
          {lyricsStatus === "loading" ? <Loader2 /> : lyricsDisabled ? <MessageSquareOff /> : <MessageSquare />}
        </span>
      </button>
      <div className="fullscreen-layout">
        <div className="fullscreen-primary">
          <Cover trackId={current.id} title={current.title} large />
          <div className="fullscreen-title-row">
            <div>
              <h2 title={current.title}>{current.title}</h2>
              <p>
                <button title={displayArtist} onClick={() => onOpenArtist(current)}>{displayArtist}</button>
                <span> - </span>
                <button title={displayAlbum} onClick={() => onOpenAlbum(current)}>{displayAlbum}</button>
              </p>
            </div>
            <div className="fullscreen-actions">
              <button className={current.favorite ? "round-action heart-on" : "round-action"} onClick={() => onFavorite(current)} title={current.favorite ? "取消收藏" : "收藏"}>
                <Heart />
              </button>
              <div className="fullscreen-menu-wrap" ref={menuRef}>
                <button className="round-action" onClick={() => setMenuOpen((value) => !value)} title="更多">
                  <MoreHorizontal />
                </button>
                {menuOpen ? (
                  <div className="fullscreen-menu">
                    <div className="menu-nested">
                      <button type="button" onClick={() => setPlaylistMenuOpen((value) => !value)}>
                        <span>添加到歌单</span>
                        <ListMusic />
                      </button>
                      {playlistMenuOpen ? (
                        <div className="fullscreen-submenu">
                          <button disabled={playlistMenuBusy} className="submenu-create-trigger" onClick={() => setCreatingPlaylist((value) => !value)}>
                            <span>新歌单</span>
                            <Plus />
                          </button>
                          {creatingPlaylist ? (
                            <div className="submenu-create">
                              <input
                                value={newPlaylistNameInline}
                                disabled={playlistMenuBusy}
                                maxLength={200}
                                onChange={(event) => {
                                  setNewPlaylistNameInline(event.currentTarget.value);
                                  setNewPlaylistError("");
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") void createPlaylistFromMenu(current);
                                }}
                                placeholder="歌单名称"
                                autoFocus
                              />
                              <button disabled={playlistMenuBusy} onClick={() => void createPlaylistFromMenu(current)}>{playlistMenuBusy ? "处理中…" : "创建并添加"}</button>
                            </div>
                          ) : null}
                          {playlists.length > 0 ? playlists.map((playlist) => (
                            <button
                              key={playlist.id}
                              disabled={playlistMenuBusy}
                              onClick={() => void runPlaylistMenuAction(current, () => onAddToPlaylist(playlist.id, current))}
                            >
                              <span>{playlist.name}</span>
                            </button>
                          )) : (
                            <button disabled>
                              <span>暂无歌单</span>
                            </button>
                          )}
                        </div>
                      ) : null}
                    </div>
                    {playlistMenuBusy ? <p className="playlist-menu-status" role="status">正在更新歌单…</p> : null}
                    {newPlaylistError ? <p className="playlist-menu-error" role="alert">{newPlaylistError} 请再次点击操作按钮重试。</p> : null}
                    <button className={current.favorite ? "heart-on" : ""} onClick={() => { onFavorite(current); setPlaylistMenuOpen(false); setMenuOpen(false); }}>
                      <span>{current.favorite ? "取消收藏" : "个人收藏"}</span>
                      <Heart />
                    </button>
                    <button onClick={() => { setPlaylistMenuOpen(false); setMenuOpen(false); onOpenArtist(current); }}>
                      <span>前往艺人</span>
                      <UserRound />
                    </button>
                    <button onClick={() => { setPlaylistMenuOpen(false); setMenuOpen(false); onOpenAlbum(current); }}>
                      <span>前往专辑</span>
                      <AlbumIcon />
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="fullscreen-progress">
            <input
              style={progressStyle}
              aria-label="播放进度"
              type="range"
              min="0"
              max={duration}
              step="1"
              value={displayPosition}
              {...seekInput.inputProps}
            />
            <div>
              <span>{formatDuration(displayPosition)}</span>
              <span>{formatRemaining(displayPosition, current.duration)}</span>
            </div>
          </div>
          <div className="fullscreen-controls">
            <button className={shuffleEnabled ? "ghost-control mode-control mode-active" : "ghost-control mode-control"} role="switch" aria-checked={shuffleEnabled} onClick={onToggleShuffle} title={shuffleEnabled ? "关闭随机播放" : "随机播放"}>
              <PlayerShuffleIcon />
            </button>
            <button className="transport-control" onClick={onPrevious} title="上一首">
              <SkipBack />
            </button>
            <button className="main-control" onClick={onToggle} title={playing ? "暂停" : "播放"}>
              {playing ? <Pause /> : <Play />}
            </button>
            <button className="transport-control" onClick={() => onNext()} title="下一首">
              <SkipForward />
            </button>
            <button className={`ghost-control mode-control repeat-control repeat-${repeatMode}`} role="switch" aria-checked={repeatMode !== "off"} onClick={onToggleRepeatMode} title={`播放模式：${repeatModeTitle(repeatMode)}`}>
              {repeatMode === "one" ? <PlayerRepeatOneIcon /> : <PlayerRepeatIcon />}
            </button>
          </div>
          <div className="fullscreen-volume">
            <button onClick={onToggleMuted} title={muted || volume === 0 ? "恢复音量" : "静音"}>
              {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
            </button>
            <input
              aria-label="音量"
              type="range"
              min="0"
              max="100"
              step="1"
              value={Math.round((muted ? 0 : volume) * 100)}
              onChange={(event) => onVolumeChange(Number(event.currentTarget.value) / 100)}
            />
          </div>
          <div className="fullscreen-mobile-tabs" aria-label="播放页视图">
            <button
              className={[lyricsOpen ? "active" : "", lyricsStatus === "loading" ? "lyrics-loading-state" : ""].filter(Boolean).join(" ")}
              type="button"
              disabled={lyricsDisabled}
              onClick={toggleLyricsView}
              aria-pressed={lyricsOpen}
              title={lyricsDisabled ? "暂无歌词" : "歌词"}
            >
              <span className="lyrics-button-icon">
                {lyricsStatus === "loading" ? <Loader2 /> : lyricsDisabled ? <MessageSquareOff /> : <MessageSquare />}
              </span>
            </button>
            <button
              className={mobileQueueOpen ? "active" : ""}
              type="button"
              onClick={() => {
                setLyricsOpen(false);
                setMobileQueueOpen((value) => !value);
              }}
              aria-pressed={mobileQueueOpen}
              title="待播清单"
            >
              <ListMusic />
            </button>
          </div>
          <div className="fullscreen-mobile-lyrics" aria-label="歌词">
            <div className="mobile-current-track">
              <Cover trackId={current.id} title={current.title} />
              <div>
                <strong title={current.title}>{current.title}</strong>
                <span>{displayArtist} - {displayAlbum}</span>
              </div>
            </div>
            <LyricsPanel
              activeIndex={activeIndex}
              hasSyncedLyrics={hasSyncedLyrics}
              lines={lyricsLines}
              status={lyricsStatus}
            />
          </div>
          <div className="fullscreen-mobile-queue" aria-label="待播清单">
            <div className="mobile-current-track">
              <Cover trackId={current.id} title={current.title} />
              <div>
                <strong title={current.title}>{current.title}</strong>
                <span>{displayArtist} - {displayAlbum}</span>
              </div>
            </div>
            <div className="mobile-queue-heading">
              <strong>接下来播放</strong>
              <span>
                <PlayerShuffleIcon />
                <PlayerRepeatIcon />
                <span aria-hidden="true">∞</span>
              </span>
            </div>
            <div className="mobile-queue-list">
              {upcomingQueue.length > 0 ? queuePage.items.map((track) => (
                <button key={track.id} type="button" className="mobile-queue-item" onClick={() => {
                  onSelectQueueTrack(track);
                }}>
                  <Cover trackId={track.id} title={track.title} />
                  <span>
                    <strong title={track.title}>{track.title}</strong>
                    <em>{track.artist ?? track.albumArtist ?? "未知艺人"}</em>
                  </span>
                  <time>{formatDuration(track.duration)}</time>
                </button>
              )) : (
                <p className="mobile-queue-empty">没有待播歌曲</p>
              )}
              {upcomingQueue.length > 0 ? <Pagination page={queuePage} loading={false} onChange={setQueuePageOffset} label="待播清单" /> : null}
            </div>
          </div>
        </div>
        <LyricsPanel
          activeIndex={activeIndex}
          hasSyncedLyrics={hasSyncedLyrics}
          lines={lyricsLines}
          status={lyricsStatus}
        />
      </div>
    </section>
  );
}

function LyricsPanel({
  activeIndex,
  hasSyncedLyrics,
  lines,
  status
}: {
  activeIndex: number;
  hasSyncedLyrics: boolean;
  lines: LyricLine[];
  status: LyricsStatus;
}) {
  const className = `fullscreen-lyrics ${hasSyncedLyrics ? "synced" : "plain"}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [trackOffset, setTrackOffset] = useState(0);

  useEffect(() => {
    if (!hasSyncedLyrics || activeIndex < 0 || status !== "ready") {
      setTrackOffset(0);
      return;
    }
    const container = containerRef.current;
    if (!container || container.clientHeight <= 0) return;
    const activeLine = container.querySelector<HTMLElement>("[data-active='true']");
    if (!activeLine) return;

    window.requestAnimationFrame(() => {
      const focusY = container.clientHeight * 0.34;
      const lineCenter = activeLine.offsetTop + activeLine.offsetHeight * 0.5;
      setTrackOffset(focusY - lineCenter);
    });
  }, [activeIndex, hasSyncedLyrics, status]);

  if (status === "loading") {
    return (
      <div className={className} ref={containerRef}>
        <p className="lyrics-loading">正在载入歌词...</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className={className} ref={containerRef}>
        <p className="lyrics-loading">歌词载入失败</p>
      </div>
    );
  }

  return (
    <div className={className} ref={containerRef}>
      <div className="lyrics-track" style={{ "--lyrics-offset": `${trackOffset}px` } as CSSProperties}>
        {lines.map((line, index) => (
          <p
            key={`${line.time ?? "plain"}-${line.text}-${index}`}
            className={hasSyncedLyrics && index === activeIndex ? "active" : ""}
            data-active={hasSyncedLyrics && index === activeIndex ? "true" : undefined}
          >
            {line.text}
          </p>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ onScan }: { onScan: () => void }) {
  return (
    <section className="empty-state">
      <Sparkles />
      <h2>还没有扫描曲库</h2>
      <p>挂载 NAS 音乐目录后，开始扫描即可建立索引。</p>
      <button className="primary" onClick={onScan}>
        <RefreshCw />
        <span>开始扫描</span>
      </button>
    </section>
  );
}

type QueuePreparation = {
  state: "loading" | "ready" | "error";
  label: string;
  filter: { q?: string; favorite?: boolean };
  loaded: number;
  total: number;
  tracks?: Track[];
  message?: string;
};

function Pagination({ page, loading, onChange, label }: { page: Page<unknown>; loading: boolean; onChange: (offset: number) => void; label: string }) {
  const count = Math.max(1, Math.ceil(page.total / page.limit));
  const number = Math.min(count, Math.floor(page.offset / page.limit) + 1);
  return <nav className="collection-pagination" aria-label={`${label}分页`}>
    <span>{loading ? "正在加载…" : `共 ${page.total} 项 · 第 ${number} / ${count} 页`}</span>
    <div>
      <button type="button" disabled={loading || page.offset === 0} onClick={() => onChange(page.offset - page.limit)}>上一页</button>
      <button type="button" disabled={loading || page.offset + page.limit >= page.total} onClick={() => onChange(page.offset + page.limit)}>下一页</button>
    </div>
  </nav>;
}

function PageFeedback({ loading, error, empty, onRetry }: { loading: boolean; error: string; empty: boolean; onRetry: () => void }) {
  if (loading) return <p className="request-feedback" role="status"><Loader2 className="spin" /> 正在加载…</p>;
  if (error) return <div className="request-feedback error-text" role="alert"><span>{error}</span><button type="button" onClick={onRetry}>重试</button></div>;
  if (empty) return <p className="collection-empty">暂无结果</p>;
  return null;
}

export function App() {
  const isMobileShell = useMemo(() => isMobileBrowserUA(), []);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<LibrarySummary | null>(null);
  const [scan, setScan] = useState<ScanJob | null>(null);
  const [scanErrors, setScanErrors] = useState<ScanError[]>([]);
  const [metadata, setMetadata] = useState<MetadataStatus | null>(null);
  const [recentAlbums, setRecentAlbums] = useState<Album[]>([]);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [view, setView] = useState<View>(() => viewFromHash());
  const [backgroundView, setBackgroundView] = useState<View>(() => {
    const initialView = viewFromHash();
    return initialView.name === "playing" ? homeView() : initialView;
  });
  const [search, setSearch] = useState(() => { const initial = viewFromHash(); return initial.name === "search" ? initial.q : ""; });
  const [detailTracks, setDetailTracks] = useState<Track[]>([]);
  const [detailTitle, setDetailTitle] = useState("");
  const [detailAlbum, setDetailAlbum] = useState<Album | null>(null);
  const [searchCategory, setSearchCategory] = useState<{ query: string; name: "tracks" | "albums" | "artists" }>({ query: "", name: "tracks" });
  const [actionError, setActionError] = useState("");
  const [queuePreparation, setQueuePreparation] = useState<QueuePreparation | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRetry, setDetailRetry] = useState(0);
  const [libraryError, setLibraryError] = useState("");
  const [scanError, setScanError] = useState("");
  const [scanPollError, setScanPollError] = useState("");
  const [scanStarting, setScanStarting] = useState(false);
  const [scanOptionsOpen, setScanOptionsOpen] = useState(false);
  const [confirmScanPrune, setConfirmScanPrune] = useState(false);
  const [current, setCurrent] = useState<Track | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [playing, setPlaying] = useState(false);
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>({ state: "idle" });
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("off");
  const [playerPosition, setPlayerPosition] = useState(0);
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);
  const [volume, setVolume] = useState(readStoredVolume);
  const [muted, setMuted] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [playlistError, setPlaylistError] = useState("");
  const [playlistMessage, setPlaylistMessage] = useState("");
  const [playlistCreating, setPlaylistCreating] = useState(false);
  const playlistCreatePending = useRef(false);
  const [playlistRefresh, setPlaylistRefresh] = useState(0);
  const [busyPlaylistIds, setBusyPlaylistIds] = useState<Set<string>>(() => new Set());
  const playlistMutationLock = useRef(createPlaylistMutationLock());
  const playlistTrackCreator = useRef<ReturnType<typeof createTrackPlaylistAdder> | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const viewRef = useRef<View>(view);
  const historyReady = useRef(false);
  const lastStoredPlayer = useRef<{ current: Track; queue: Track[]; playing: boolean; savedAt: number } | null>(null);
  const lastAudibleVolume = useRef(volume > 0 ? volume : 0.8);
  const libraryRequests = useRef(createLatestRequest());
  const queueRequests = useRef(createLatestRequest());
  const albumNavigationRequests = useRef(createLatestRequest());
  const favoritePending = useRef(new Set<string>());
  const detailRequests = useRef(createLatestRequest());
  const scanSnapshot = useRef<ScanJob | null | undefined>(undefined);
  const scanSubmissionPending = useRef(false);
  const scanSubmissions = useRef(createLatestRequest());
  const scanPruneConfirmRef = useRef<HTMLDivElement>(null);
  const detailView = view.name === "playing" ? backgroundView : view;
  const detailViewKey = JSON.stringify(detailView);
  const searchQuery = detailView.name === "search" ? detailView.q.trim() : "";
  const trackPage = useLibraryPage(Boolean(authenticated && detailView.name === "home"), "tracks", libraryRevision, 60,
    (offset, signal) => api.trackPage({ offset, limit: 60 }, signal));
  const albumPage = useLibraryPage(Boolean(authenticated && detailView.name === "albums"), "albums", libraryRevision, 24,
    (offset, signal) => api.albumPage({ offset, limit: 24 }, signal));
  const artistPage = useLibraryPage(Boolean(authenticated && detailView.name === "artists"), "artists", libraryRevision, 30,
    (offset, signal) => api.artistPage({ offset, limit: 30 }, signal));
  const favoritePage = useLibraryPage(Boolean(authenticated && detailView.name === "favorites"), "favorites", libraryRevision, 60,
    (offset, signal) => api.trackPage({ favorite: true, offset, limit: 60 }, signal));
  const searchTracks = useLibraryPage(Boolean(authenticated && searchQuery), `tracks:${searchQuery}`, libraryRevision, 25,
    (offset, signal) => api.trackPage({ q: searchQuery, offset, limit: 25 }, signal), 250);
  const searchAlbums = useLibraryPage(Boolean(authenticated && searchQuery), `albums:${searchQuery}`, libraryRevision, 12,
    (offset, signal) => api.albumPage({ q: searchQuery, offset, limit: 12 }, signal), 250);
  const searchArtists = useLibraryPage(Boolean(authenticated && searchQuery), `artists:${searchQuery}`, libraryRevision, 12,
    (offset, signal) => api.artistPage({ q: searchQuery, offset, limit: 12 }, signal), 250);
  const tracks = trackPage.page.items;
  const albums = albumPage.page.items;
  const artists = artistPage.page.items;


  function navigateView(nextView: View) {
    albumNavigationRequests.current.cancel();
    const previousView = viewRef.current;
    viewRef.current = nextView;
    if (nextView.name === "playing") {
      if (previousView.name !== "playing") setBackgroundView(previousView);
    } else {
      setBackgroundView(nextView);
    }
    setView(nextView);
    setSearch(nextView.name === "search" ? nextView.q : nextView.name === "playing" ? search : "");
    if (!sameView(previousView, nextView)) {
      window.history.pushState(viewHistoryState(nextView, "view"), "", viewUrl(nextView));
    }
  }

  function updateSearch(value: string) {
    const nextView: View = value ? { name: "search", q: value } : homeView();
    if (viewRef.current.name !== "search") {
      navigateView(nextView);
      return;
    }
    albumNavigationRequests.current.cancel();
    viewRef.current = nextView;
    setView(nextView);
    setBackgroundView(nextView);
    setSearch(value);
    window.history.replaceState(viewHistoryState(nextView, "view"), "", viewUrl(nextView));
  }

  function navigateAndClose(nextView: View) {
    setMobileMenuOpen(false);
    navigateView(nextView);
  }

  function recordScanStatus(next: ScanJob | null, submitted = false): boolean {
    const previous = scanSnapshot.current;
    const finished = scanJustFinished(submitted && previous === undefined ? null : previous, next);
    scanSnapshot.current = next;
    setScan(next);
    if (finished) {
      setLibraryRevision((value) => value + 1);
      cancelQueuePreparation();
    }
    return finished;
  }

  async function loadAll() {
    const request = libraryRequests.current.begin();
    const scanAtStart = scanSnapshot.current;
    const { signal } = request;
    try {
      const [nextSummary, nextScan, nextErrors, nextMetadata, nextAlbums, nextPlaylists] = await Promise.all([
        api.summary(signal),
        api.scanStatus(signal),
        api.scanErrors(signal),
        api.metadataStatus(signal),
        api.albumPage({ limit: 12 }, signal),
        api.playlists(signal)
      ]);
      if (!request.isCurrent()) return;
      setSummary(nextSummary);
      // A newer submission or poll may have completed while these reads ran.
      if (!scanSubmissionPending.current && scanSnapshot.current === scanAtStart) recordScanStatus(nextScan);
      setScanErrors(nextErrors);
      setMetadata(nextMetadata);
      setRecentAlbums(nextAlbums.items);
      setPlaylists(nextPlaylists);
      setLibraryError("");
    } catch (error) {
      if (request.isCurrent()) setLibraryError(error instanceof Error ? `曲库加载失败：${error.message}` : "曲库加载失败，请重试。");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    api.me(controller.signal)
      .then(() => {
        if (controller.signal.aborted) return;
        const stored = readStoredPlayer();
        if (stored) {
          setCurrent(stored.current);
          setQueue(stored.queue.length > 0 ? stored.queue : [stored.current]);
          setPlaying(stored.playing);
          setPlayerPosition(stored.position ?? 0);
        }
        setAuthenticated(true);
      })
      .catch(() => { if (!controller.signal.aborted) setAuthenticated(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (authenticated) {
      setScanStarting(false);
      void loadAll();
    }
    return () => {
      libraryRequests.current.cancel();
      scanSubmissions.current.cancel();
      scanSubmissionPending.current = false;
    };
  }, [authenticated]);

  useEffect(() => {
    if (confirmScanPrune) scanPruneConfirmRef.current?.focus();
  }, [confirmScanPrune]);

  useEffect(() => {
    document.body.classList.toggle("mobile-ua", isMobileShell);
    return () => document.body.classList.remove("mobile-ua");
  }, [isMobileShell]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileMenuOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileMenuOpen]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const baseView = homeView();
    if (!historyReady.current) {
      historyReady.current = true;
      const initialView = viewFromHash();
      viewRef.current = initialView;
      setBackgroundView(initialView.name === "playing" ? baseView : initialView);
      setView(initialView);
      window.history.replaceState(viewHistoryState(baseView, "base"), "", viewUrl(baseView));
      window.history.pushState(viewHistoryState(initialView, "view"), "", viewUrl(initialView));
    }

    function handlePopState(event: PopStateEvent) {
      albumNavigationRequests.current.cancel();
      const state = event.state as ViewHistoryState | null;
      if (state?.[VIEW_HISTORY_KEY] === "view" && isView(state.view)) {
        viewRef.current = state.view;
        if (state.view.name !== "playing") setBackgroundView(state.view);
        setView(state.view);
        setSearch(state.view.name === "search" ? state.view.q : "");
        return;
      }

      viewRef.current = baseView;
      setBackgroundView(baseView);
      setView(baseView);
      setSearch("");
      window.history.pushState(viewHistoryState(baseView, "view"), "", viewUrl(baseView));
    }

    function handleHashChange() {
      albumNavigationRequests.current.cancel();
      const nextView = viewFromHash();
      if (sameView(viewRef.current, nextView)) return;
      viewRef.current = nextView;
      if (nextView.name !== "playing") setBackgroundView(nextView);
      setView(nextView);
      setSearch(nextView.name === "search" ? nextView.q : "");
    }

    window.addEventListener("popstate", handlePopState);
    window.addEventListener("hashchange", handleHashChange);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  useEffect(() => {
    if (!current) return;
    const previous = lastStoredPlayer.current;
    const now = Date.now();
    if (previous && previous.current === current && previous.queue === queue && previous.playing === playing && now - previous.savedAt < 1000) return;
    lastStoredPlayer.current = { current, queue, playing, savedAt: now };
    writeStoredPlayer({
      current,
      queue: queue.length > 0 ? queue : [current],
      playing,
      position: playerPosition,
      updatedAt: Date.now()
    });
  }, [current, queue, playing, playerPosition]);

  useEffect(() => {
    writeStoredVolume(volume);
    if (volume > 0) lastAudibleVolume.current = volume;
  }, [volume]);

  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    let timer: number;
    async function poll() {
      const scanAtStart = scanSnapshot.current;
      try {
        const nextScan = await api.scanStatus(controller.signal);
        if (controller.signal.aborted) return;
        setScanPollError("");
        if (!scanSubmissionPending.current && scanSnapshot.current === scanAtStart) {
          if (recordScanStatus(nextScan)) await loadAll();
        }
      } catch {
        if (!controller.signal.aborted) setScanPollError("暂时无法获取扫描状态，正在重试连接。");
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 3000);
      }
    }
    timer = window.setTimeout(() => void poll(), 3000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [authenticated]);

  useEffect(() => {
    const request = detailRequests.current.begin();
    setDetailTracks([]);
    setDetailTitle("");
    setDetailAlbum(null);
    setDetailError("");
    const isDetail = ["album", "artist"].includes(detailView.name);
    setDetailLoading(Boolean(authenticated && isDetail));
    async function loadDetail() {
      try {
        let title = "";
        let nextTracks: Track[] = [];
        let nextAlbum: Album | null = null;
        if (detailView.name === "album") {
          const detail = await api.album(detailView.key, request.signal);
          title = detail.album.title;
          nextAlbum = detail.album;
          nextTracks = detail.tracks;
        } else if (detailView.name === "artist") {
          const detail = await api.artist(detailView.nameValue, request.signal);
          title = detail.artist.name;
          nextTracks = detail.tracks;
        }
        if (!request.isCurrent()) return;
        setDetailTitle(title);
        setDetailAlbum(nextAlbum);
        setDetailTracks(nextTracks);
      } catch (error) {
        if (request.isCurrent()) setDetailError(error instanceof Error ? `加载失败：${error.message}` : "加载失败，请重试。");
      } finally {
        if (request.isCurrent()) setDetailLoading(false);
      }
    }
    if (authenticated && isDetail) void loadDetail();
    return () => detailRequests.current.cancel();
  }, [detailViewKey, authenticated, detailRetry, libraryRevision]);

  const visibleTracks = searchQuery ? searchTracks.page.items
    : detailView.name === "favorites" ? favoritePage.page.items
    : ["album", "artist"].includes(detailView.name) ? detailTracks : tracks;

  useEffect(() => () => {
    queueRequests.current.cancel();
    albumNavigationRequests.current.cancel();
  }, [authenticated]);

  function cancelQueuePreparation() {
    queueRequests.current.cancel();
    setQueuePreparation(null);
  }

  async function prepareFullQueue(filter: { q?: string; favorite?: boolean }, label: string) {
    const request = queueRequests.current.begin();
    setQueuePreparation({ state: "loading", filter, label, loaded: 0, total: 0 });
    try {
      const allTracks = await api.allTracks(filter, request.signal, (loaded, total) => {
        if (request.isCurrent()) setQueuePreparation({ state: "loading", filter, label, loaded, total });
      });
      if (!request.isCurrent()) return;
      if (!allTracks.length) throw new Error("没有可播放的歌曲，请刷新列表后重试。");
      setQueuePreparation({ state: "ready", filter, label, tracks: allTracks, loaded: allTracks.length, total: allTracks.length });
    } catch (error) {
      if (request.isCurrent()) setQueuePreparation({ state: "error", filter, label, loaded: 0, total: 0, message: error instanceof Error ? error.message : "队列加载失败，请重试。" });
    }
  }

  async function startScan(options?: ScanOptions) {
    if (scanSubmissionPending.current || scanSnapshot.current?.status === "running") return;
    scanSubmissionPending.current = true;
    const request = scanSubmissions.current.begin();
    setScanStarting(true);
    setScanError("");
    try {
      const nextScan = await api.scan(options, request.signal);
      if (!request.isCurrent()) return;
      const finished = recordScanStatus(nextScan, true);
      setScanErrors([]);
      setScanError("");
      setConfirmScanPrune(false);
      if (finished) await loadAll();
    } catch (error) {
      if (request.isCurrent()) setScanError(error instanceof Error ? `启动扫描失败：${error.message}` : "启动扫描失败，请重试。");
    } finally {
      if (request.isCurrent()) {
        scanSubmissionPending.current = false;
        setScanStarting(false);
      }
    }
  }

  function playTrack(track: Track, source = visibleTracks) {
    cancelQueuePreparation();
    window.__nasMusicPlayTrack?.(track.id);
    setCurrent(track);
    setQueue(source);
    setPlayerPosition(0);
    setPlaying(true);
  }

  function togglePlayback() {
    cancelQueuePreparation();
    if (playing) {
      setPlaying(false);
      return;
    }
    if (current) {
      window.__nasMusicResume?.();
      setPlaying(true);
      return;
    }
    setPlaying(true);
  }

  function requestSeek(position: number) {
    const next = Math.max(0, Math.min(position, current?.duration ?? position));
    setPlayerPosition(next);
    setSeekRequest({ id: Date.now(), position: next });
  }

  function changeVolume(nextVolume: number) {
    const normalized = Math.max(0, Math.min(nextVolume, 1));
    setVolume(normalized);
    setMuted(normalized === 0);
  }

  function toggleMuted() {
    if (muted || volume === 0) {
      setMuted(false);
      if (volume === 0) setVolume(lastAudibleVolume.current);
      return;
    }
    setMuted(true);
  }

  function randomNextTrack(): Track | undefined {
    if (queue.length === 0) return undefined;
    if (queue.length === 1) return queue[0];
    const candidates = queue.filter((track) => track.id !== current?.id);
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  function cycleRepeatMode() {
    setRepeatMode((mode) => {
      if (mode === "off") return "one";
      if (mode === "one") return "all";
      return "off";
    });
  }

  function playNext(auto = false) {
    if (!auto) cancelQueuePreparation();
    if (!current || queue.length === 0) return setPlaying(false);
    if (repeatMode === "one") {
      requestSeek(0);
      setPlaying(true);
      return;
    }
    if (shuffleEnabled) {
      const shuffled = randomNextTrack();
      if (shuffled && (shuffled.id !== current.id || repeatMode === "all")) {
        if (shuffled.id === current.id) {
          requestSeek(0);
          setPlaying(true);
          return;
        }
        setPlayerPosition(0);
        setCurrent(shuffled);
        setPlaying(true);
        return;
      }
      setPlaying(false);
      return;
    }
    const index = queue.findIndex((track) => track.id === current.id);
    const next = queue[index + 1] ?? (repeatMode === "all" || !auto ? queue[0] : undefined);
    if (next) {
      if (next.id === current.id) {
        requestSeek(0);
        setPlaying(repeatMode === "all" || auto);
        return;
      }
      setPlayerPosition(0);
      setCurrent(next);
      setPlaying(repeatMode === "all" || auto || index + 1 < queue.length);
    }
    else setPlaying(false);
  }

  function playPrevious() {
    cancelQueuePreparation();
    if (!current || queue.length === 0) return;
    const index = queue.findIndex((track) => track.id === current.id);
    const previous = queue[index - 1];
    if (previous) {
      setPlayerPosition(0);
      setCurrent(previous);
      setPlaying(true);
    } else {
      requestSeek(0);
    }
  }

  async function openAlbumForTrack(track: Track) {
    const request = albumNavigationRequests.current.begin();
    setActionError("");
    try {
      const key = track.albumKey ?? (await api.track(track.id, request.signal)).albumKey;
      if (!request.isCurrent()) return;
      if (!key) throw new Error("无法找到这首歌曲的专辑，请刷新曲库后重试。");
      navigateView({ name: "album", key });
    } catch (error) {
      if (request.isCurrent()) setActionError(error instanceof Error ? error.message : "打开专辑失败，请重试。");
    }
  }

  function openArtistForTrack(track: Track) {
    const artist = track.albumArtist ?? track.artist;
    if (artist) navigateView({ name: "artist", nameValue: artist });
  }

  function playlistChanged(playlist: Playlist, refreshDetail = true) {
    setPlaylists((items) => items.some((item) => item.id === playlist.id) ? items.map((item) => item.id === playlist.id ? playlist : item) : [playlist, ...items]);
    if (refreshDetail) setPlaylistRefresh((value) => value + 1);
    void loadAll();
  }

  async function mutatePlaylist<T,>(id: string, operation: () => Promise<T>): Promise<T> {
    return playlistMutationLock.current(id, async () => {
      setBusyPlaylistIds((items) => new Set(items).add(id));
      try { return await operation(); }
      finally { setBusyPlaylistIds((items) => { const next = new Set(items); next.delete(id); return next; }); }
    });
  }

  async function addPlaylistTrack(playlistId: string, trackId: string) {
    const detail = await mutatePlaylist(playlistId, () => api.addToPlaylist(playlistId, trackId));
    playlistChanged(detail.playlist);
    setPlaylistError("");
    setPlaylistMessage(`已添加到「${detail.playlist.name}」`);
  }

  async function addTrackToPlaylist(playlistId: string, track: Track) {
    await addPlaylistTrack(playlistId, track.id);
  }

  async function createPlaylistForTrack(name: string, track: Track) {
    if (!playlistTrackCreator.current) playlistTrackCreator.current = createTrackPlaylistAdder(api.createPlaylist, addPlaylistTrack, playlistChanged);
    await playlistTrackCreator.current(name, track.id);
    setPlaylistMessage(`已创建「${name.trim()}」并添加歌曲`);
  }

  function playlistDeleted(id: string) {
    setPlaylists((items) => items.filter((item) => item.id !== id));
    setPlaylistMessage("歌单已删除，音乐文件仍保留。");
    setPlaylistRefresh((value) => value + 1);
    const active = viewRef.current;
    if (active.name === "playlist" && active.id === id) navigateView({ name: "playlists" });
    void loadAll();
  }

  async function toggleFavorite(track: Track) {
    if (favoritePending.current.has(track.id)) return;
    favoritePending.current.add(track.id);
    setActionError("");
    try {
      const updated = await api.favorite(track.id, !track.favorite);
      const replace = (item: Track) => (item.id === updated.id ? updated : item);
      trackPage.replaceItems((items) => items.map(replace));
      searchTracks.replaceItems((items) => items.map(replace));
      favoritePage.replaceItems((items) => items.map(replace).filter((item) => item.favorite));
      setDetailTracks((items) => items.map(replace));
      setQueue((items) => items.map(replace));
      setCurrent((item) => item?.id === updated.id ? updated : item);
      cancelQueuePreparation();
      setLibraryRevision((value) => value + 1);
      void loadAll();
    } catch (error) {
      setActionError(error instanceof Error ? `收藏更新失败：${error.message}` : "收藏更新失败，请重试。");
    } finally {
      favoritePending.current.delete(track.id);
    }
  }

  async function createPlaylist() {
    if (playlistCreatePending.current) return;
    const name = newPlaylistName.trim();
    if (!name) { setPlaylistError("请输入歌单名称"); setPlaylistMessage(""); return; }
    playlistCreatePending.current = true;
    setPlaylistCreating(true);
    setPlaylistError("");
    try {
      const playlist = await api.createPlaylist(name);
      setNewPlaylistName("");
      setPlaylistMessage(`已创建「${playlist.name}」`);
      playlistChanged(playlist);
    } catch (err) {
      setPlaylistError(err instanceof Error ? err.message : "创建歌单失败，请重试。");
      setPlaylistMessage("");
    } finally {
      playlistCreatePending.current = false;
      setPlaylistCreating(false);
    }
  }

  if (authenticated === null) {
    return <div className="loading"><Loader2 className="spin" /> 正在进入曲库</div>;
  }

  if (!authenticated) {
    return <Login onLogin={() => setAuthenticated(true)} />;
  }

  const contentView = view.name === "playing" && isMobileShell ? backgroundView : view;
  const scanBusy = scanStarting || scan?.status === "running";
  const showScanPanel = scanOptionsOpen || scanBusy || scan?.status === "failed";
  const hasSearch = contentView.name === "search";
  const showLibraryHero = contentView.name === "home";
  const selectedSearchCategory = searchCategory.query === searchQuery ? searchCategory.name : "tracks";
  const scanIssueCount = scan?.errorCount ?? scanErrors.length;
  const shellClassName = [
    "app-shell",
    isMobileShell ? "mobile-shell" : "",
    mobileMenuOpen ? "mobile-nav-open" : ""
  ].filter(Boolean).join(" ");

  return (
    <div className={shellClassName}>
      {isMobileShell ? (
        <header className="mobile-header">
          <button
            className={`mobile-icon-button mobile-menu-toggle ${mobileMenuOpen ? "open" : ""}`}
            type="button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            aria-label={mobileMenuOpen ? "关闭侧边栏" : "打开侧边栏"}
            aria-expanded={mobileMenuOpen}
          >
            <span />
            <span />
          </button>
          <div className="mobile-brand"><Disc3 /> Music Library</div>
          <button className="mobile-icon-button mobile-user-button" type="button" aria-label="账户">
            <UserRound />
          </button>
        </header>
      ) : null}

      <aside className="sidebar" aria-hidden={isMobileShell && !mobileMenuOpen ? "true" : undefined}>
        {!isMobileShell ? (
          <div className="brand desktop-brand">
            <Disc3 />
            <span className="brand-full">Music Library</span>
            <span className="brand-short">Music</span>
          </div>
        ) : null}
        {!isMobileShell ? (
          <label className="sidebar-search-box">
            <Search />
            <input value={search} onChange={(event) => updateSearch(event.target.value)} placeholder="搜索" />
          </label>
        ) : null}
        <nav className="sidebar-nav" aria-label="导航">
          <button type="button" className={contentView.name === "home" ? "selected" : ""} onClick={() => navigateAndClose({ name: "home" })}><Library /> 首页</button>
          <button type="button" className={contentView.name === "albums" || contentView.name === "album" ? "selected" : ""} onClick={() => navigateAndClose({ name: "albums" })}><AlbumIcon /> 专辑</button>
          <button type="button" className={contentView.name === "artists" ? "selected" : ""} onClick={() => navigateAndClose({ name: "artists" })}><UserRound /> 艺人</button>
          <button type="button" className={contentView.name === "favorites" ? "selected" : ""} onClick={() => navigateAndClose({ name: "favorites" })}><Heart /> 收藏</button>
          <button type="button" className={contentView.name === "playlists" || contentView.name === "playlist" ? "selected" : ""} onClick={() => navigateAndClose({ name: "playlists" })}><ListMusic /> 歌单</button>
        </nav>
        <div className="sidebar-footer">
          <button className="logout" type="button" onClick={() => api.logout().then(() => setAuthenticated(false))}><LogOut /> 退出</button>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div className="search-box">
            <Search />
            <input value={search} onChange={(event) => updateSearch(event.target.value)} placeholder="搜索歌曲、专辑、艺人" />
          </div>
          <div className="scan-toolbar">
            <button className="primary" onClick={() => void startScan()} disabled={scanBusy}>
              {scanBusy ? <Loader2 className="spin" /> : <RefreshCw />}
              <span className="primary-label">{scanStarting ? "正在启动" : scan?.status === "running" ? "扫描中" : "扫描曲库"}</span>
            </button>
            <button className="scan-options-toggle" type="button" title="扫描选项" aria-label="扫描选项" aria-expanded={scanOptionsOpen} aria-controls="scan-options" onClick={() => { setScanOptionsOpen((value) => !value); setConfirmScanPrune(false); }}><MoreHorizontal /></button>
          </div>
        </header>

        {libraryError ? <div className="request-feedback error-text" role="alert"><span>{libraryError}</span><button onClick={() => void loadAll()}>重试</button></div> : null}
        {scanError ? <div className="request-feedback error-text" role="alert"><span>{scanError}</span><button type="button" disabled={scanBusy} onClick={() => void startScan()}>重试增量扫描</button></div> : null}
        {scanPollError ? <p className="request-feedback error-text" role="alert">{scanPollError}</p> : null}
        {showScanPanel ? <section className="scan-panel" aria-label="曲库扫描">
          {scan ? <>
            <div className="scan-panel-heading"><strong>{scan.status === "failed" ? "扫描未完成" : scan.status === "running" ? "正在扫描曲库" : "最近扫描"}</strong><span>{scan.force ? "重新解析全部" : "增量扫描"}{scan.prune ? " · 启用缺失索引清理" : ""}</span></div>
            <dl className="scan-metrics">
              <div><dt>已检查</dt><dd>{scan.scannedFiles} / {scan.totalFiles}</dd></div>
              <div><dt>重新解析</dt><dd>{scan.parsedFiles ?? 0}</dd></div>
              <div><dt>跳过</dt><dd>{scan.skippedFiles ?? 0}</dd></div>
              <div><dt>错误</dt><dd>{scan.errorCount}</dd></div>
            </dl>
            <p className={scan.status === "failed" ? "error-text" : ""} role={scan.status === "failed" ? "alert" : "status"}>{scan.message ?? (scan.status === "failed" ? "扫描未完成，请确认 NAS 连接后重新扫描。" : scan.status === "completed" ? "扫描已完成。" : "正在检查音乐目录。")}</p>
            {scan.status === "failed" ? <div className="scan-retry"><span>重新发起增量扫描，会跳过已处理且未变化的文件。</span><button type="button" disabled={scanBusy} onClick={() => void startScan()}>重新扫描</button></div> : null}
          </> : <p>默认仅处理新增或变化的文件，保留暂时找不到的歌曲索引。</p>}
          {scanOptionsOpen ? <div className="scan-options" id="scan-options">
            <p>默认扫描保留缺失索引；重新解析会再次读取所有音频的元数据，耗时较长。</p>
            <div className="scan-option-actions">
              <button type="button" disabled={scanBusy} onClick={() => void startScan({ force: true })}>重新解析全部</button>
              <button type="button" disabled={scanBusy} onClick={() => setConfirmScanPrune(true)}>清理缺失索引…</button>
            </div>
            {confirmScanPrune ? <div className="scan-prune-confirm" role="alertdialog" aria-labelledby="scan-prune-title" aria-describedby="scan-prune-description" tabIndex={-1} ref={scanPruneConfirmRef}>
              <h3 id="scan-prune-title">确认清理缺失索引？</h3>
              <p id="scan-prune-description">请先确认 NAS 音乐目录及所有子目录已完整挂载。只有扫描完整且无错误时，才会从曲库、歌单和收藏中移除此次未找到的歌曲。音乐文件不会被修改。</p>
              <div className="scan-option-actions"><button type="button" className="danger-action" disabled={scanBusy} onClick={() => void startScan({ prune: true })}>已确认挂载完整，开始清理</button><button type="button" disabled={scanStarting} onClick={() => setConfirmScanPrune(false)}>取消</button></div>
            </div> : null}
          </div> : null}
        </section> : null}
        {actionError ? <div className="request-feedback action-notice error-text" role="alert"><span>{actionError}</span><button type="button" onClick={() => setActionError("")}>关闭</button></div> : null}
        {queuePreparation ? <section className="queue-preparation" aria-label="准备播放队列" aria-busy={queuePreparation.state === "loading"}>
          <div role={queuePreparation.state === "error" ? "alert" : "status"}>
            {queuePreparation.state === "loading" ? <Loader2 className="spin" /> : null}
            <span>{queuePreparation.label}：{queuePreparation.state === "loading" ? `加载全部歌曲…${queuePreparation.total ? ` ${queuePreparation.loaded} / ${queuePreparation.total}` : ""}` : queuePreparation.state === "ready" ? `已准备 ${queuePreparation.total} 首，点击开始播放。` : queuePreparation.message}</span>
          </div>
          <div className="queue-preparation-actions">
            {queuePreparation.state === "ready" ? <button className="primary" type="button" onClick={() => { const prepared = queuePreparation.tracks; if (prepared?.[0]) playTrack(prepared[0], prepared); }}><Play /> 开始播放（{queuePreparation.total} 首）</button> : null}
            {queuePreparation.state === "error" ? <button type="button" onClick={() => void prepareFullQueue(queuePreparation.filter, queuePreparation.label)}>重试</button> : null}
            <button type="button" onClick={cancelQueuePreparation}>取消</button>
          </div>
        </section> : null}

        {showLibraryHero ? (
          <section className="hero home-hero">
            <div>
              <span className="eyebrow">只读 NAS 曲库</span>
              <h1>你的音乐库</h1>
            </div>
            <StatBar summary={summary} />
          </section>
        ) : null}

        {summary?.trackCount === 0 && !hasSearch && !scanBusy ? <EmptyState onScan={() => void startScan()} /> : null}

        {!hasSearch && contentView.name === "home" ? (
          <details className="library-status">
            <summary>
              <span>{metadata?.enabled ? "在线补全已开启" : "本地标签优先"}</span>
              <span>{scan?.status === "failed" ? "最近扫描未完成" : scan?.status === "running" ? `正在扫描 ${scan.scannedFiles} / ${scan.totalFiles}` : scan?.status === "completed" ? "最近扫描已完成" : "尚未扫描"}</span>
              {scanIssueCount > 0 ? <strong className="error-text">{scanIssueCount} 首未能读取</strong> : null}
              <span>查看详情</span>
            </summary>
            <p>已检查 {scan?.scannedFiles ?? 0} / {scan?.totalFiles ?? 0} · 解析 {scan?.parsedFiles ?? 0} · 跳过 {scan?.skippedFiles ?? 0} · 元数据缓存 {metadata?.cachedItems ?? 0} 条</p>
            {scanIssueCount > 0 ? <>
              <p>部分文件未能读取，其余已入库歌曲可以正常播放。请检查下方文件是否完整、NAS 是否可读，然后重试增量扫描。</p>
              <div className="scan-error-list">{scanErrors.map((error) => <details className="scan-error-item" key={error.id}>
                <summary>{error.path.split(/[\\/]/).pop() || "未知文件"}</summary>
                <p className="scan-error-path">{error.path}</p>
                <p>错误详情：{error.message}</p>
              </details>)}</div>
              {!scanErrors.length ? <p>暂无文件详情，请重试扫描后查看。</p> : null}
              <button type="button" disabled={scanBusy} onClick={() => void startScan()}>重试增量扫描</button>
            </> : <p>没有未能读取的文件。</p>}
          </details>
        ) : null}

        {hasSearch ? (
          <>
            <header className="search-heading">
              <h1>搜索结果</h1>
              <p>“{searchQuery}”</p>
              <nav className="search-categories" aria-label="搜索结果分类">
                {([['tracks', '歌曲', searchTracks], ['albums', '专辑', searchAlbums], ['artists', '艺人', searchArtists]] as const).map(([name, label, result]) => <button key={name} type="button" aria-pressed={selectedSearchCategory === name} onClick={() => setSearchCategory({ query: searchQuery, name })}>{label} <span>{result.loading ? "…" : result.error ? "暂不可用" : result.page.total}</span></button>)}
              </nav>
            </header>
            {selectedSearchCategory === "tracks" ? <section className="section" aria-busy={searchTracks.loading}>
              <div className="section-title"><h2>匹配歌曲</h2><button type="button" disabled={!searchTracks.page.total || searchTracks.loading} onClick={() => void prepareFullQueue({ q: searchQuery }, `搜索「${searchQuery}」`)}><Play /> 播放全部结果</button></div>
              <PageFeedback loading={searchTracks.loading} error={searchTracks.error} empty={!searchTracks.page.items.length} onRetry={searchTracks.retry} />
              {!searchTracks.loading && !searchTracks.error ? <>
                {searchTracks.page.items.length ? <p className="collection-hint">点击歌曲会播放当前页；“播放全部结果”包含所有匹配歌曲。</p> : null}
                <div className="track-list">{searchTracks.page.items.map((track, index) => <TrackRow key={track.id} track={track} index={searchTracks.page.offset + index + 1} active={current?.id === track.id} playing={playing} playlists={playlists} onPlay={() => playTrack(track, searchTracks.page.items)} onAddToPlaylist={addTrackToPlaylist} onCreatePlaylist={createPlaylistForTrack} onFavorite={toggleFavorite} />)}</div>
              </> : null}
              <Pagination page={searchTracks.page} loading={searchTracks.loading} onChange={searchTracks.setOffset} label="匹配歌曲" />
            </section> : null}
            {selectedSearchCategory === "albums" ? <section className="section" aria-busy={searchAlbums.loading}>
              <h2>匹配专辑</h2>
              <PageFeedback loading={searchAlbums.loading} error={searchAlbums.error} empty={!searchAlbums.page.items.length} onRetry={searchAlbums.retry} />
              <AlbumGrid albums={searchAlbums.page.items} onOpen={(album) => navigateView({ name: "album", key: album.key })} />
              <Pagination page={searchAlbums.page} loading={searchAlbums.loading} onChange={searchAlbums.setOffset} label="匹配专辑" />
            </section> : null}
            {selectedSearchCategory === "artists" ? <section className="section" aria-busy={searchArtists.loading}>
              <h2>匹配艺人</h2>
              <PageFeedback loading={searchArtists.loading} error={searchArtists.error} empty={!searchArtists.page.items.length} onRetry={searchArtists.retry} />
              <ArtistList artists={searchArtists.page.items} onOpen={(artist) => navigateView({ name: "artist", nameValue: artist.name })} />
              <Pagination page={searchArtists.page} loading={searchArtists.loading} onChange={searchArtists.setOffset} label="匹配艺人" />
            </section> : null}
          </>
        ) : contentView.name === "playing" ? null
        : contentView.name === "albums" ? (
          <section className="section" aria-busy={albumPage.loading}>
            <h2>专辑{!albumPage.loading && !albumPage.error ? ` · ${albumPage.page.total}` : ""}</h2>
            <PageFeedback loading={albumPage.loading} error={albumPage.error} empty={!albums.length} onRetry={albumPage.retry} />
            <AlbumGrid albums={albums} onOpen={(album) => navigateView({ name: "album", key: album.key })} />
            <Pagination page={albumPage.page} loading={albumPage.loading} onChange={albumPage.setOffset} label="专辑" />
          </section>
        ) : contentView.name === "artists" ? (
          <section className="section" aria-busy={artistPage.loading}>
            <h2>艺人</h2>
            <PageFeedback loading={artistPage.loading} error={artistPage.error} empty={!artists.length} onRetry={artistPage.retry} />
            <ArtistList artists={artists} onOpen={(artist) => navigateView({ name: "artist", nameValue: artist.name })} />
            <Pagination page={artistPage.page} loading={artistPage.loading} onChange={artistPage.setOffset} label="艺人" />
          </section>
        ) : contentView.name === "favorites" ? (
          <section className="section" aria-busy={favoritePage.loading}>
            <div className="section-title"><h2>收藏</h2><button type="button" disabled={!favoritePage.page.total || favoritePage.loading} onClick={() => void prepareFullQueue({ favorite: true }, "全部收藏")}><Play /> 播放全部收藏</button></div>
            <PageFeedback loading={favoritePage.loading} error={favoritePage.error} empty={!favoritePage.page.items.length} onRetry={favoritePage.retry} />
            {favoritePage.page.items.length ? <p className="collection-hint">点击歌曲会播放当前页；“播放全部收藏”包含所有收藏歌曲。</p> : null}
            <div className="track-list">{favoritePage.page.items.map((track, index) => <TrackRow key={track.id} track={track} index={favoritePage.page.offset + index + 1} active={current?.id === track.id} playing={playing} playlists={playlists} onPlay={() => playTrack(track, favoritePage.page.items)} onAddToPlaylist={addTrackToPlaylist} onCreatePlaylist={createPlaylistForTrack} onFavorite={toggleFavorite} />)}</div>
            <Pagination page={favoritePage.page} loading={favoritePage.loading} onChange={favoritePage.setOffset} label="收藏" />
          </section>
        ) : contentView.name === "playlists" ? (
          <section className="section">
            <h2>歌单</h2>
            <div className="playlist-create">
              <input value={newPlaylistName} disabled={playlistCreating} maxLength={200} onChange={(event) => { setNewPlaylistName(event.target.value); setPlaylistError(""); }} placeholder="新歌单名称" aria-invalid={playlistError ? "true" : "false"} />
              <button disabled={playlistCreating} onClick={() => void createPlaylist()}>{playlistCreating ? <Loader2 className="spin" /> : <Plus />} {playlistCreating ? "创建中…" : "新建"}</button>
            </div>
            {playlistError ? <div className="request-feedback error-text" role="alert"><span>{playlistError}</span><button type="button" disabled={playlistCreating} onClick={() => void createPlaylist()}>重试创建</button></div> : null}
            {playlistMessage ? <p className="form-message" role="status">{playlistMessage}</p> : null}
            {!playlists.length ? <div className="playlist-empty"><h3>创建你的第一张歌单</h3><p>先输入名称创建歌单，再从歌曲的“更多”菜单添加音乐。</p></div> : null}
            <div className="playlist-grid">
              {playlists.map((playlist) => (
                <button key={playlist.id} onClick={() => navigateView({ name: "playlist", id: playlist.id })}>
                  <ListMusic />
                  <strong>{playlist.name}</strong>
                  <span>{playlist.trackCount} 首 · {formatHours(playlist.duration)}</span>
                </button>
              ))}
            </div>
          </section>
        ) : contentView.name === "playlist" ? (
          <PlaylistView key={contentView.id} id={contentView.id} refresh={libraryRevision + playlistRefresh} busy={busyPlaylistIds.has(contentView.id)} mutate={mutatePlaylist} onChanged={playlistChanged} onDeleted={playlistDeleted} onBack={() => navigateView({ name: "playlists" })} onBrowse={() => navigateView({ name: "home" })} onPlay={(items) => { if (items[0]) playTrack(items[0], items); }} renderTrack={(track, index, items, remove, busy) => <TrackRow key={track.id} track={track} index={index} active={current?.id === track.id} playing={playing} playlists={playlists} onPlay={() => playTrack(track, items)} onAddToPlaylist={addTrackToPlaylist} onCreatePlaylist={createPlaylistForTrack} onFavorite={toggleFavorite} onRemove={remove} playlistBusy={busy} />} />
        ) : ["album", "artist"].includes(contentView.name) ? (
          <section className="section" aria-busy={detailLoading}>
            {detailLoading ? <p className="request-feedback" role="status"><Loader2 className="spin" /> 正在加载…</p> : null}
            {detailError ? <div className="request-feedback error-text" role="alert"><span>{detailError}</span><button onClick={() => setDetailRetry((value) => value + 1)}>重试</button></div> : null}
            <button className="detail-back" type="button" onClick={() => navigateView({ name: contentView.name === "album" ? "albums" : "artists" })}>返回{contentView.name === "album" ? "专辑" : "艺人"}列表</button>
            <div className="detail-heading">
              <Cover trackId={detailTracks.find((track) => track.hasArtwork)?.id} title={detailTitle} large />
              <div>
                <span className="eyebrow">{detailTracks.length} 首 · {formatHours(detailTracks.reduce((sum, track) => sum + (track.duration ?? 0), 0))}</span>
                <h2>{detailTitle}</h2>
                {detailAlbum ? <p className="detail-meta">{detailAlbum.artist ?? "未知艺人"}{detailAlbum.year ? ` · ${detailAlbum.year}` : ""}</p> : null}
                {detailTracks[0] ? <button className="primary" onClick={() => playTrack(detailTracks[0], detailTracks)}><Play /> 播放</button> : null}
              </div>
            </div>
            <div className={contentView.name === "album" ? "track-list album-track-list" : "track-list"}>
              {detailTracks.map((track, index) => (
                <TrackRow key={track.id} track={track} hideAlbum={contentView.name === "album"} index={index + 1} active={current?.id === track.id} playing={playing} playlists={playlists} onPlay={() => playTrack(track, detailTracks)} onAddToPlaylist={addTrackToPlaylist} onCreatePlaylist={createPlaylistForTrack} onFavorite={toggleFavorite} />
              ))}
            </div>
          </section>
        ) : (
          <>
            <section className="section">
              <div className="section-title"><h2>最近加入</h2><button onClick={() => navigateView({ name: "albums" })}>查看全部</button></div>
              <AlbumGrid albums={recentAlbums} onOpen={(album) => navigateView({ name: "album", key: album.key })} />
            </section>
            <section className="section">
              <div className="section-title"><h2>歌曲</h2><button type="button" onClick={() => void prepareFullQueue({}, "整个曲库")} disabled={!trackPage.page.total || trackPage.loading}><Play /> 播放全部</button></div>
              <PageFeedback loading={trackPage.loading} error={trackPage.error} empty={!tracks.length} onRetry={trackPage.retry} />
              {tracks.length ? <p className="collection-hint">点击歌曲会播放当前页；“播放全部”包含整个曲库。</p> : null}
              <div className="track-list">
                {visibleTracks.map((track, index) => (
                  <TrackRow key={track.id} track={track} index={trackPage.page.offset + index + 1} active={current?.id === track.id} playing={playing} playlists={playlists} onPlay={() => playTrack(track, visibleTracks)} onAddToPlaylist={addTrackToPlaylist} onCreatePlaylist={createPlaylistForTrack} onFavorite={toggleFavorite} />
                ))}
              </div>
              <Pagination page={trackPage.page} loading={trackPage.loading} onChange={trackPage.setOffset} label="歌曲" />
            </section>
          </>
        )}
      </main>

        {view.name === "playing" ? (
          <FullscreenPlayer
            current={current}
            onlineMetadataEnabled={metadata?.enabled ?? false}
            queue={queue}
            isMobileShell={isMobileShell}
          playing={playing}
          position={playerPosition}
          repeatMode={repeatMode}
          shuffleEnabled={shuffleEnabled}
          volume={volume}
          muted={muted}
          playlists={playlists}
          onAddToPlaylist={addTrackToPlaylist}
          onClose={() => window.history.back()}
          onCreatePlaylistForTrack={createPlaylistForTrack}
          onFavorite={toggleFavorite}
          onNext={playNext}
          onOpenAlbum={openAlbumForTrack}
          onOpenArtist={openArtistForTrack}
          onPrevious={playPrevious}
          onSeek={requestSeek}
          onSelectQueueTrack={(track) => playTrack(track, queue)}
          onToggleRepeatMode={cycleRepeatMode}
          onToggleShuffle={() => setShuffleEnabled((value) => !value)}
          onToggle={togglePlayback}
          onToggleMuted={toggleMuted}
          onVolumeChange={changeVolume}
        />
      ) : null}

      <Player
        current={current}
        queue={queue}
        playing={playing}
        initialPosition={playerPosition}
        seekRequest={seekRequest}
        onPlaybackStatusChange={setPlaybackStatus}
        volume={volume}
        muted={muted}
        onProgressChange={setPlayerPosition}
        onPlayingChange={setPlaying}
        onOpenAlbum={openAlbumForTrack}
        onOpenArtist={openArtistForTrack}
        onOpenNowPlaying={() => navigateView({ name: "playing" })}
        onVolumeChange={changeVolume}
        onMutedChange={setMuted}
        onPrevious={playPrevious}
        onNext={() => playNext(false)}
        repeatMode={repeatMode}
        shuffleEnabled={shuffleEnabled}
        onToggleRepeatMode={cycleRepeatMode}
        onToggleShuffle={() => setShuffleEnabled((value) => !value)}
        onSelectQueueTrack={(track) => playTrack(track, queue)}
        onClearUpcoming={() => {
          cancelQueuePreparation();
          setQueue(current ? [current] : []);
        }}
        onToggle={togglePlayback}
        onEnded={() => playNext(true)}
      />
      {current && "message" in playbackStatus ? (
        <div className={`playback-notice ${view.name === "playing" ? "fullscreen-notice" : ""} ${playbackStatus.state === "error" ? "playback-error" : ""}`} role={playbackStatus.state === "error" ? "alert" : "status"}>
          {playbackStatus.state !== "error" ? <Loader2 className="spin" aria-hidden="true" /> : null}
          <span>{playbackStatus.message}</span>
          <button type="button" onClick={() => { cancelQueuePreparation(); window.__nasMusicRetry?.(); }}>重试</button>
        </div>
      ) : null}
    </div>
  );
}
