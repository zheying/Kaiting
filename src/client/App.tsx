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
import { api, artworkUrl, streamUrl } from "./api.js";
import type { Album, Artist, LibrarySummary, MetadataStatus, Playlist, ScanError, ScanJob, SearchResponse, Track } from "../shared/types.js";

type View =
  | { name: "home" }
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
  }
}

function homeView(): View {
  return { name: "home" };
}

function isView(value: unknown): value is View {
  if (!value || typeof value !== "object") return false;
  const view = value as Record<string, unknown>;
  if (["home", "albums", "artists", "favorites", "playlists", "playing"].includes(String(view.name))) return true;
  if (view.name === "album") return typeof view.key === "string";
  if (view.name === "artist") return typeof view.nameValue === "string";
  if (view.name === "playlist") return typeof view.id === "string";
  return false;
}

function viewFromHash(): View {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash) return homeView();
  const [name, value = ""] = hash.split("/");
  const decoded = decodeURIComponent(value);
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
  window.sessionStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(state));
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
  onFavorite
}: {
  track: Track;
  index?: number;
  active: boolean;
  playing: boolean;
  playlists: Playlist[];
  onPlay: (track: Track) => void;
  onAddToPlaylist: (playlistId: string, track: Track) => void;
  onCreatePlaylist: (name: string, track: Track) => Promise<void>;
  onFavorite: (track: Track) => void;
}) {
  const activePlaying = active && playing;
  const [menuOpen, setMenuOpen] = useState(false);
  const [playlistMenuOpen, setPlaylistMenuOpen] = useState(false);
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [newPlaylistError, setNewPlaylistError] = useState("");
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
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  async function createPlaylistFromMenu() {
    const name = newPlaylistName.trim();
    if (!name) {
      setNewPlaylistError("请输入歌单名称");
      return;
    }
    await onCreatePlaylist(name, track);
    setNewPlaylistName("");
    setNewPlaylistError("");
    setCreatingPlaylist(false);
    setPlaylistMenuOpen(false);
    setMenuOpen(false);
  }

  function addToPlaylist(playlistId: string) {
    onAddToPlaylist(playlistId, track);
    setPlaylistMenuOpen(false);
    setMenuOpen(false);
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
    <div className={active ? "track-row active" : "track-row"}>
      <button className={active ? "icon-button now-button" : "icon-button"} title={activePlaying ? "正在播放" : active ? "已暂停" : "播放"} onClick={() => onPlay(track)}>
        {active ? <Equalizer paused={!playing} /> : <Play />}
      </button>
      <span className="track-index">{index ?? ""}</span>
      <div className="track-main">
        <strong>{track.title}</strong>
        <span>{track.artist ?? "未知艺人"}</span>
      </div>
      <span className="track-album">{track.album ?? "未知专辑"}</span>
      <span className="track-codec">{track.formatGroup.toUpperCase()}</span>
      <span>{formatDuration(track.duration)}</span>
      <div className={`track-menu-wrap ${menuPlacement === "up" ? "open-up" : "open-down"}`} ref={menuRef}>
        <button ref={menuButtonRef} className="icon-button track-menu-button" title="更多" aria-expanded={menuOpen} onClick={toggleMenu}>
          <MoreHorizontal />
        </button>
        {menuOpen ? (
          <div className="track-menu">
            <div className="menu-nested">
              <button type="button" onClick={() => setPlaylistMenuOpen((value) => !value)}>
                <span>添加到歌单</span>
                <ListMusic />
              </button>
              {playlistMenuOpen ? (
                <div className="track-submenu">
                  <button className="submenu-create-trigger" onClick={() => setCreatingPlaylist((value) => !value)}>
                    <span>新歌单</span>
                    <Plus />
                  </button>
                  {creatingPlaylist ? (
                    <div className="submenu-create">
                      <input
                        value={newPlaylistName}
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
                      <button onClick={() => void createPlaylistFromMenu()}>创建</button>
                      {newPlaylistError ? <small>{newPlaylistError}</small> : null}
                    </div>
                  ) : null}
                  {playlists.length > 0 ? playlists.map((playlist) => (
                    <button key={playlist.id} onClick={() => addToPlaylist(playlist.id)}>
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
          <strong>{album.title}</strong>
          <span>{album.artist ?? "未知艺人"}</span>
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
  const playPending = useRef(false);
  const ignorePauseUntil = useRef(0);
  const volumeControlRef = useRef<HTMLDivElement>(null);
  const queuePanelRef = useRef<HTMLElement>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [progressHover, setProgressHover] = useState(false);
  const [volumeExpanded, setVolumeExpanded] = useState(false);
  const [volumeDragging, setVolumeDragging] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const displayArtist = current?.artist ?? current?.albumArtist ?? "未知艺人";
  const displayAlbum = current?.album ?? "未知专辑";
  const currentQueueIndex = current ? queue.findIndex((track) => track.id === current.id) : -1;
  const upcomingQueue = currentQueueIndex >= 0 ? queue.slice(currentQueueIndex + 1) : queue;
  const effectiveVolume = muted ? 0 : volume;
  const volumePercent = Math.round(effectiveVolume * 100);
  const volumeLevel: 1 | 2 | 3 = effectiveVolume < 0.34 ? 1 : effectiveVolume < 0.68 ? 2 : 3;

  function updateStreamOffset(value: number) {
    streamOffsetRef.current = value;
  }

  function requestPlay(audio: HTMLAudioElement) {
    playPending.current = true;
    ignorePauseUntil.current = window.performance.now() + 1800;
    void audio.play()
      .then(() => {
        playPending.current = false;
      })
      .catch((error) => {
        playPending.current = false;
        console.warn("播放启动失败", error);
        onPlayingChange(false);
      });
  }

  useEffect(() => {
    function playTrackFromGesture(trackId: string) {
      const audio = audioRef.current;
      if (!audio) return;
      const nextSrc = streamUrl(trackId);
      if (audio.getAttribute("src") !== nextSrc) audio.src = nextSrc;
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
      onPlayingChange(true);
      requestPlay(audio);
    }

    window.__nasMusicPlayTrack = playTrackFromGesture;
    window.__nasMusicResume = resumeFromGesture;
    return () => {
      if (window.__nasMusicPlayTrack === playTrackFromGesture) delete window.__nasMusicPlayTrack;
      if (window.__nasMusicResume === resumeFromGesture) delete window.__nasMusicResume;
    };
  }, [current?.id]);

  function handleTogglePlayback() {
    if (playing) {
      ignorePauseUntil.current = 0;
      onToggle();
      return;
    }
    const audio = audioRef.current;
    if (audio && current) {
      onPlayingChange(true);
      requestPlay(audio);
      return;
    }
    onToggle();
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    const restorePosition = restoredTrackId.current === current.id ? 0 : Math.max(0, initialPosition || 0);
    restoredTrackId.current = current.id;
    setPosition(restorePosition);
    setDuration(current.duration ?? 0);
    if (usesTranscodedStream(current) && restorePosition > 0) {
      pendingDirectSeek.current = 0;
      updateStreamOffset(restorePosition);
      audio.src = streamUrl(current.id, restorePosition);
    } else {
      pendingDirectSeek.current = restorePosition;
      updateStreamOffset(0);
      audio.src = streamUrl(current.id);
    }
    if (playing) requestPlay(audio);
  }, [current?.id]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (playing) requestPlay(audio);
    else {
      ignorePauseUntil.current = 0;
      audio.pause();
    }
  }, [playing, current]);

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
      if (event.key === "Escape") setQueueOpen(false);
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
    if (!audio || seeking) return;
    const next = mediaPosition(audio);
    setPosition(next);
    onProgressChange(next);
  }

  function handleLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio) return;
    const nextDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : current?.duration ?? 0;
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
      audio.src = streamUrl(current.id, next);
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
    audio.src = streamUrl(current.id);
    if (playing) requestPlay(audio);
  }

  function handlePause() {
    const audio = audioRef.current;
    if (audio?.ended) return;
    if (playPending.current) return;
    if (window.performance.now() < ignorePauseUntil.current) return;
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

  if (!current) {
    return (
      <footer className="player empty-player">
        <audio ref={audioRef} />
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
    );
  }

  const playbackDuration = Math.max(duration || current.duration || 0, 1);
  const playbackPosition = Math.min(position, playbackDuration);
  const progressPercent = (playbackPosition / playbackDuration) * 100;

  return (
    <>
    <footer className="player">
      <audio
        ref={audioRef}
        onEnded={onEnded}
        onLoadedMetadata={handleLoadedMetadata}
        onPause={handlePause}
        onPlay={() => onPlayingChange(true)}
        onTimeUpdate={handleTimeUpdate}
      />
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
          <strong>{current.title}</strong>
          <span className="now-links">
            <button onClick={() => onOpenArtist(current)}>{displayArtist}</button>
            <span aria-hidden="true"> - </span>
            <button onClick={() => onOpenAlbum(current)}>{displayAlbum}</button>
            <span aria-hidden="true"> · 队列 {queue.length} 首</span>
          </span>
        </div>
        <span className="mini-progress-time current-time">{formatDuration(position)}</span>
        <span className="mini-progress-time remaining-time">{formatRemaining(position, duration || current.duration)}</span>
        <input
          className="mini-progress"
          style={{ "--progress": `${progressPercent}%` } as CSSProperties}
          aria-label="播放进度"
          type="range"
          min="0"
          max={playbackDuration}
          step="1"
          value={playbackPosition}
          onChange={(event) => setPosition(Number(event.currentTarget.value))}
          onMouseEnter={() => setProgressHover(true)}
          onMouseLeave={() => setProgressHover(false)}
          onPointerEnter={() => setProgressHover(true)}
          onPointerLeave={() => setProgressHover(false)}
          onPointerDown={() => {
            setProgressHover(true);
            setSeeking(true);
          }}
          onPointerUp={(event) => {
            setSeeking(false);
            seekTo(Number(event.currentTarget.value));
          }}
          onFocus={() => setProgressHover(true)}
          onBlur={() => setProgressHover(false)}
          onKeyUp={(event) => seekTo(Number(event.currentTarget.value))}
        />
      </div>

      <div className="player-actions">
        <button
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
          <span className="queue-repeat-indicator" aria-label={repeatMode === "all" ? "列表循环" : "队列"}>
            {repeatMode === "all" ? "∞" : ""}
          </span>
        </header>
        {upcomingQueue.length > 0 ? (
          <div className="queue-list">
            {upcomingQueue.map((track) => (
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
                  <strong>{track.title}</strong>
                  <span>{track.artist ?? track.albumArtist ?? "未知艺人"}</span>
                </span>
                <span className="queue-duration">{formatDuration(track.duration)}</span>
              </button>
            ))}
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
  onAddToPlaylist: (playlistId: string, track: Track) => void;
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
  const [seeking, setSeeking] = useState(false);
  const [draftPosition, setDraftPosition] = useState(position);
  const [mobileQueueOpen, setMobileQueueOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeTimeoutRef = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMenuOpen(false);
    setPlaylistMenuOpen(false);
    setCreatingPlaylist(false);
    setNewPlaylistNameInline("");
    setNewPlaylistError("");
    setSeeking(false);
    setDraftPosition(0);
    setMobileQueueOpen(false);
    setLyricsOpen(false);
  }, [current?.id]);

  useEffect(() => {
    if (!seeking) setDraftPosition(position);
  }, [position, seeking]);

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

  const duration = Math.max(current.duration ?? 0, 1);
  const displayPosition = Math.min(seeking ? draftPosition : position, duration);
  const displayArtist = current.artist ?? current.albumArtist ?? "未知艺人";
  const displayAlbum = current.album ?? "未知专辑";
  const background = artworkUrl(current.id);
  const currentQueueIndex = queue.findIndex((track) => track.id === current.id);
  const upcomingQueue = currentQueueIndex >= 0 ? queue.slice(currentQueueIndex + 1) : queue.filter((track) => track.id !== current.id);
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

  function commitSeek(value: number) {
    const next = Math.max(0, Math.min(value, duration));
    setDraftPosition(next);
    setSeeking(false);
    onSeek(next);
  }

  async function createPlaylistFromMenu(track: Track) {
    const name = newPlaylistNameInline.trim();
    if (!name) {
      setNewPlaylistError("请输入歌单名称");
      return;
    }
    await onCreatePlaylistForTrack(name, track);
    setNewPlaylistNameInline("");
    setNewPlaylistError("");
    setCreatingPlaylist(false);
    setPlaylistMenuOpen(false);
    setMenuOpen(false);
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
              <h2>{current.title}</h2>
              <p>
                <button onClick={() => onOpenArtist(current)}>{displayArtist}</button>
                <span> - </span>
                <button onClick={() => onOpenAlbum(current)}>{displayAlbum}</button>
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
                          <button className="submenu-create-trigger" onClick={() => setCreatingPlaylist((value) => !value)}>
                            <span>新歌单</span>
                            <Plus />
                          </button>
                          {creatingPlaylist ? (
                            <div className="submenu-create">
                              <input
                                value={newPlaylistNameInline}
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
                              <button onClick={() => void createPlaylistFromMenu(current)}>创建</button>
                              {newPlaylistError ? <small>{newPlaylistError}</small> : null}
                            </div>
                          ) : null}
                          {playlists.length > 0 ? playlists.map((playlist) => (
                            <button
                              key={playlist.id}
                              onClick={() => {
                                onAddToPlaylist(playlist.id, current);
                                setPlaylistMenuOpen(false);
                                setMenuOpen(false);
                              }}
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
              onChange={(event) => {
                setSeeking(true);
                setDraftPosition(Number(event.currentTarget.value));
              }}
              onPointerDown={(event) => {
                setSeeking(true);
                setDraftPosition(Number(event.currentTarget.value));
              }}
              onPointerUp={(event) => commitSeek(Number(event.currentTarget.value))}
              onPointerCancel={(event) => commitSeek(Number(event.currentTarget.value))}
              onKeyDown={() => setSeeking(true)}
              onKeyUp={(event) => commitSeek(Number(event.currentTarget.value))}
              onBlur={(event) => {
                if (seeking) commitSeek(Number(event.currentTarget.value));
              }}
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
                <strong>{current.title}</strong>
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
                <strong>{current.title}</strong>
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
              {upcomingQueue.length > 0 ? upcomingQueue.map((track) => (
                <button key={track.id} type="button" className="mobile-queue-item" onClick={() => {
                  onSelectQueueTrack(track);
                }}>
                  <Cover trackId={track.id} title={track.title} />
                  <span>
                    <strong>{track.title}</strong>
                    <em>{track.artist ?? track.albumArtist ?? "未知艺人"}</em>
                  </span>
                  <time>{formatDuration(track.duration)}</time>
                </button>
              )) : (
                <p className="mobile-queue-empty">没有待播歌曲</p>
              )}
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

export function App() {
  const isMobileShell = useMemo(() => isMobileBrowserUA(), []);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<LibrarySummary | null>(null);
  const [scan, setScan] = useState<ScanJob | null>(null);
  const [scanErrors, setScanErrors] = useState<ScanError[]>([]);
  const [metadata, setMetadata] = useState<MetadataStatus | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [view, setView] = useState<View>(() => viewFromHash());
  const [backgroundView, setBackgroundView] = useState<View>(() => {
    const initialView = viewFromHash();
    return initialView.name === "playing" ? homeView() : initialView;
  });
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null);
  const [detailTracks, setDetailTracks] = useState<Track[]>([]);
  const [detailTitle, setDetailTitle] = useState("");
  const [current, setCurrent] = useState<Track | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [playing, setPlaying] = useState(false);
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("off");
  const [playerPosition, setPlayerPosition] = useState(0);
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);
  const [volume, setVolume] = useState(readStoredVolume);
  const [muted, setMuted] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [playlistError, setPlaylistError] = useState("");
  const [playlistMessage, setPlaylistMessage] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const viewRef = useRef<View>(view);
  const historyReady = useRef(false);
  const lastAudibleVolume = useRef(volume > 0 ? volume : 0.8);

  function navigateView(nextView: View) {
    const previousView = viewRef.current;
    viewRef.current = nextView;
    if (nextView.name === "playing") {
      if (previousView.name !== "playing") setBackgroundView(previousView);
    } else {
      setBackgroundView(nextView);
    }
    setView(nextView);
    setSearch("");
    setSearchResults(null);
    if (!sameView(previousView, nextView)) {
      window.history.pushState(viewHistoryState(nextView, "view"), "", viewUrl(nextView));
    }
  }

  function navigateAndClose(nextView: View) {
    setMobileMenuOpen(false);
    navigateView(nextView);
  }

  async function loadAll() {
    const [nextSummary, nextScan, nextErrors, nextMetadata, nextTracks, nextAlbums, nextArtists, nextPlaylists] = await Promise.all([
      api.summary(),
      api.scanStatus(),
      api.scanErrors().catch(() => []),
      api.metadataStatus().catch(() => null),
      api.tracks("?limit=60"),
      api.albums(),
      api.artists(),
      api.playlists()
    ]);
    setSummary(nextSummary);
    setScan(nextScan);
    setScanErrors(nextErrors);
    setMetadata(nextMetadata);
    setTracks(nextTracks);
    setAlbums(nextAlbums);
    setArtists(nextArtists);
    setPlaylists(nextPlaylists);
  }

  useEffect(() => {
    api.me()
      .then(async () => {
        setAuthenticated(true);
        await loadAll();
        const stored = readStoredPlayer();
        if (stored) {
          setCurrent(stored.current);
          setQueue(stored.queue.length > 0 ? stored.queue : [stored.current]);
          setPlaying(stored.playing);
          setPlayerPosition(stored.position ?? 0);
        }
      })
      .catch(() => setAuthenticated(false));
  }, []);

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
      const state = event.state as ViewHistoryState | null;
      if (state?.[VIEW_HISTORY_KEY] === "view" && isView(state.view)) {
        viewRef.current = state.view;
        if (state.view.name !== "playing") setBackgroundView(state.view);
        setView(state.view);
        setSearch("");
        setSearchResults(null);
        return;
      }

      viewRef.current = baseView;
      setBackgroundView(baseView);
      setView(baseView);
      setSearch("");
      setSearchResults(null);
      window.history.pushState(viewHistoryState(baseView, "view"), "", viewUrl(baseView));
    }

    function handleHashChange() {
      const nextView = viewFromHash();
      if (sameView(viewRef.current, nextView)) return;
      viewRef.current = nextView;
      if (nextView.name !== "playing") setBackgroundView(nextView);
      setView(nextView);
      setSearch("");
      setSearchResults(null);
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
    const timer = window.setInterval(async () => {
      const nextScan = await api.scanStatus().catch(() => null);
      setScan(nextScan);
      if (nextScan?.status === "completed") void loadAll();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    const q = search.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void api.search(q).then(setSearchResults);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, authenticated]);

  useEffect(() => {
    async function loadDetail() {
      if (view.name === "album") {
        const detail = await api.album(view.key);
        setDetailTitle(detail.album.title);
        setDetailTracks(detail.tracks);
      } else if (view.name === "artist") {
        const detail = await api.artist(view.nameValue);
        setDetailTitle(detail.artist.name);
        setDetailTracks(detail.tracks);
      } else if (view.name === "playlist") {
        const detail = await api.playlist(view.id);
        setDetailTitle(detail.playlist.name);
        setDetailTracks(detail.tracks);
      } else if (view.name === "favorites") {
        const favoriteTracks = await api.tracks("?favorite=true&limit=200");
        setDetailTitle("收藏");
        setDetailTracks(favoriteTracks);
      }
    }
    if (authenticated) void loadDetail();
  }, [view, authenticated]);

  const visibleTracks = useMemo(() => {
    if (searchResults) return searchResults.tracks;
    if (["album", "artist", "playlist", "favorites"].includes(view.name)) return detailTracks;
    return tracks;
  }, [searchResults, view, detailTracks, tracks]);

  async function startScan() {
    const nextScan = await api.scan();
    setScan(nextScan);
    setScanErrors([]);
  }

  function playTrack(track: Track, source = visibleTracks) {
    window.__nasMusicPlayTrack?.(track.id);
    setCurrent(track);
    setQueue(source);
    setPlayerPosition(0);
    setPlaying(true);
  }

  function togglePlayback() {
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

  function albumForTrack(track: Track): Album | undefined {
    const albumTitle = track.album ?? "未知专辑";
    const albumArtist = track.albumArtist ?? track.artist ?? "未知艺人";
    return albums.find((album) =>
      album.title === albumTitle && ((album.artist ?? "未知艺人") === albumArtist || !track.albumArtist)
    ) ?? albums.find((album) => album.title === albumTitle);
  }

  function openAlbumForTrack(track: Track) {
    const album = albumForTrack(track);
    if (album) navigateView({ name: "album", key: album.key });
    else navigateView({ name: "albums" });
  }

  function openArtistForTrack(track: Track) {
    const artist = track.albumArtist ?? track.artist;
    if (artist) navigateView({ name: "artist", nameValue: artist });
  }

  async function addTrackToPlaylist(playlistId: string, track: Track) {
    const detail = await api.addToPlaylist(playlistId, track.id);
    setPlaylists(await api.playlists());
    if (view.name === "playlist" && view.id === playlistId) {
      setDetailTitle(detail.playlist.name);
      setDetailTracks(detail.tracks);
    }
    setPlaylistError("");
    setPlaylistMessage(`已添加到「${detail.playlist.name}」`);
  }

  async function createPlaylistForTrack(name: string, track: Track) {
    const playlist = await api.createPlaylist(name);
    await addTrackToPlaylist(playlist.id, track);
    setPlaylistMessage(`已创建「${playlist.name}」并添加歌曲`);
  }

  async function toggleFavorite(track: Track) {
    const updated = await api.favorite(track.id, !track.favorite);
    const replace = (item: Track) => (item.id === updated.id ? updated : item);
    setTracks((items) => items.map(replace));
    setDetailTracks((items) => items.map(replace));
    setQueue((items) => items.map(replace));
    if (current?.id === updated.id) setCurrent(updated);
    void loadAll();
  }

  async function createPlaylist() {
    const name = newPlaylistName.trim();
    if (!name) {
      setPlaylistError("请输入歌单名称");
      setPlaylistMessage("");
      return;
    }
    try {
      const playlist = await api.createPlaylist(name);
      setNewPlaylistName("");
      setPlaylistError("");
      setPlaylistMessage(`已创建「${playlist.name}」`);
      setPlaylists(await api.playlists());
    } catch (err) {
      setPlaylistError(err instanceof Error ? err.message : "创建歌单失败");
      setPlaylistMessage("");
    }
  }

  if (authenticated === null) {
    return <div className="loading"><Loader2 className="spin" /> 正在进入曲库</div>;
  }

  if (!authenticated) {
    return <Login onLogin={() => { setAuthenticated(true); void loadAll(); }} />;
  }

  const contentView = view.name === "playing" && isMobileShell ? backgroundView : view;
  const showLibraryHero = contentView.name === "home" || Boolean(searchResults);
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
          <div className="brand desktop-brand"><Disc3 /> Music Library</div>
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
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索歌曲、专辑、艺人" />
          </div>
          <button className="primary" onClick={startScan} disabled={scan?.status === "running"}>
            {scan?.status === "running" ? <Loader2 className="spin" /> : <RefreshCw />}
            {scan?.status === "running" ? "扫描中" : "扫描曲库"}
          </button>
        </header>

        {showLibraryHero ? (
          <section className="hero">
            <div>
              <span className="eyebrow">只读 NAS 曲库</span>
              <h1>{searchResults ? "搜索结果" : "你的音乐库"}</h1>
              <p>{scan?.message ?? "本地标签优先，封面和歌词自动索引，M4A/ALAC 按需兼容播放。"}</p>
            </div>
            <StatBar summary={summary} />
          </section>
        ) : null}

        {(summary?.trackCount ?? 0) === 0 ? <EmptyState onScan={startScan} /> : null}

        {!searchResults && contentView.name === "home" ? (
          <section className="status-strip" aria-label="运行状态">
            <div>
              <span>元数据</span>
              <strong>{metadata?.enabled ? "在线补全" : "本地优先"}</strong>
              <small>{metadata?.cachedItems ?? 0} 条缓存</small>
            </div>
            <div>
              <span>最近扫描</span>
              <strong>{scan?.status === "failed" ? "失败" : scan?.status === "running" ? "运行中" : scan?.status === "completed" ? "完成" : "未开始"}</strong>
              <small>{scan?.errorCount ?? 0} 个错误</small>
            </div>
            <div>
              <span>错误文件</span>
              <strong>{scanErrors.length}</strong>
              <small>{scanErrors[0]?.message ?? "无"}</small>
            </div>
          </section>
        ) : null}

        {searchResults ? (
          <section className="section">
            <h2>匹配歌曲</h2>
            <div className="track-list">
              {searchResults.tracks.map((track, index) => (
                <TrackRow key={track.id} track={track} index={index + 1} active={current?.id === track.id} playing={playing} playlists={playlists} onPlay={() => playTrack(track, searchResults.tracks)} onAddToPlaylist={addTrackToPlaylist} onCreatePlaylist={createPlaylistForTrack} onFavorite={toggleFavorite} />
              ))}
            </div>
            <h2>匹配专辑</h2>
            <AlbumGrid albums={searchResults.albums} onOpen={(album) => navigateView({ name: "album", key: album.key })} />
            <h2>匹配艺人</h2>
            <ArtistList artists={searchResults.artists} onOpen={(artist) => navigateView({ name: "artist", nameValue: artist.name })} />
          </section>
        ) : contentView.name === "playing" ? null
        : contentView.name === "albums" ? (
          <section className="section"><h2>专辑</h2><AlbumGrid albums={albums} onOpen={(album) => navigateView({ name: "album", key: album.key })} /></section>
        ) : contentView.name === "artists" ? (
          <section className="section"><h2>艺人</h2><ArtistList artists={artists} onOpen={(artist) => navigateView({ name: "artist", nameValue: artist.name })} /></section>
        ) : contentView.name === "playlists" ? (
          <section className="section">
            <h2>歌单</h2>
            <div className="playlist-create">
              <input value={newPlaylistName} onChange={(event) => { setNewPlaylistName(event.target.value); setPlaylistError(""); }} placeholder="新歌单名称" aria-invalid={playlistError ? "true" : "false"} />
              <button onClick={createPlaylist}><Plus /> 新建</button>
            </div>
            {playlistError ? <p className="form-message error-text">{playlistError}</p> : null}
            {playlistMessage ? <p className="form-message">{playlistMessage}</p> : null}
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
        ) : ["album", "artist", "playlist", "favorites"].includes(contentView.name) ? (
          <section className="section">
            <div className="detail-heading">
              <Cover trackId={detailTracks.find((track) => track.hasArtwork)?.id} title={detailTitle} large />
              <div>
                <span className="eyebrow">{detailTracks.length} 首 · {formatHours(detailTracks.reduce((sum, track) => sum + (track.duration ?? 0), 0))}</span>
                <h2>{detailTitle}</h2>
                {detailTracks[0] ? <button className="primary" onClick={() => playTrack(detailTracks[0], detailTracks)}><Play /> 播放</button> : null}
              </div>
            </div>
            <div className="track-list">
              {detailTracks.map((track, index) => (
                <TrackRow key={track.id} track={track} index={index + 1} active={current?.id === track.id} playing={playing} playlists={playlists} onPlay={() => playTrack(track, detailTracks)} onAddToPlaylist={addTrackToPlaylist} onCreatePlaylist={createPlaylistForTrack} onFavorite={toggleFavorite} />
              ))}
            </div>
          </section>
        ) : (
          <>
            <section className="section">
              <div className="section-title"><h2>最近加入</h2><button onClick={() => navigateView({ name: "albums" })}>查看全部</button></div>
              <AlbumGrid albums={albums.slice(0, 12)} onOpen={(album) => navigateView({ name: "album", key: album.key })} />
            </section>
            <section className="section">
              <div className="section-title"><h2>歌曲</h2><button onClick={() => playTrack(tracks[0], tracks)} disabled={!tracks[0]}><Play /> 播放全部</button></div>
              <div className="track-list">
                {visibleTracks.map((track, index) => (
                  <TrackRow key={track.id} track={track} index={index + 1} active={current?.id === track.id} playing={playing} playlists={playlists} onPlay={() => playTrack(track, visibleTracks)} onAddToPlaylist={addTrackToPlaylist} onCreatePlaylist={createPlaylistForTrack} onFavorite={toggleFavorite} />
                ))}
              </div>
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
          onSelectQueueTrack={(track) => {
            setPlayerPosition(0);
            setCurrent(track);
            setPlaying(true);
          }}
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
        onSelectQueueTrack={(track) => {
          setPlayerPosition(0);
          setCurrent(track);
          setPlaying(true);
        }}
        onClearUpcoming={() => {
          setQueue(current ? [current] : []);
        }}
        onToggle={togglePlayback}
        onEnded={() => playNext(true)}
      />
    </div>
  );
}
