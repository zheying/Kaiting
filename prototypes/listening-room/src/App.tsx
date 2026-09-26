import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronLeft,
  ChevronRight, Clock3, Disc3, Grid2X2, Headphones, Heart, House, Info, Library,
  List, ListMusic, MoreHorizontal, Music2, Pause, Play, Plus,
  Search, Settings2, Shuffle, SkipForward, SlidersHorizontal, UserRound,
  X, type LucideIcon
} from "lucide-react";
import library from "./library.json";
import { CapsulePlayer } from "./CapsulePlayer";
import { NowPlaying } from "./NowPlaying";
import { useMobileLayout } from "../../../src/client/mobile-layout";

type Album = (typeof library.albums)[number];
type Track = (typeof library.tracks)[number];
type Playlist = { id: string; name: string; description: string; trackIds: string[] };
type ModalState = { type: "create"; trackId?: string } | { type: "add"; trackId: string } | { type: "info" } | { type: "settings" } | null;
const { albums, tracks } = library;
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
const navItems: { route: string; title: string; icon: LucideIcon }[] = [
  { route: "home", title: "现在就听", icon: House },
  { route: "albums", title: "专辑", icon: Disc3 },
  { route: "songs", title: "歌曲", icon: Music2 },
  { route: "artists", title: "艺人", icon: UserRound },
  { route: "favorites", title: "我的收藏", icon: Heart }
];
const readRoute = () => window.location.hash.replace(/^#\/?/, "") || "home";

function IconButton({ label, children, onClick, active = false, className = "", disabled = false }: {
  label: string; children: ReactNode; onClick: () => void; active?: boolean; className?: string; disabled?: boolean;
}) {
  return <button type="button" className={`icon-button ${active ? "is-active" : ""} ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
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
    return () => { dialog?.close(); document.body.style.overflow = originalOverflow; previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={className} aria-label={label} onCancel={(event) => { event.preventDefault(); closeRef.current(); }} onClick={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>{children}</dialog>;
}

function Cover({ album, className = "", lazy = true }: { album: Album; className?: string; lazy?: boolean }) {
  return <img className={`cover ${className}`} src={album.cover} alt={`${album.name} 专辑封面`} loading={lazy ? "lazy" : "eager"} draggable={false} />;
}

function PlaylistArt({ playlist }: { playlist: Playlist }) {
  const covers = [...new Set(playlist.trackIds.map((id) => trackMap.get(id)?.albumId).filter((id): id is string => Boolean(id)))].slice(0, 4);
  return <div className={`playlist-art ${covers.length > 1 ? "mosaic" : ""}`}>
    {covers.length ? Array.from({ length: covers.length > 1 ? 4 : 1 }, (_, index) => <Cover key={index} album={albumMap.get(covers[index % covers.length])!} />) : <ListMusic aria-hidden="true" />}
  </div>;
}

export function App() {
  const isMobile = useMobileLayout();
  const [route, setRoute] = useState(readRoute);
  const backgroundRoute = useRef("home");
  const previousPage = useRef(route === "playing" ? "home" : route);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("全部");
  const [sort, setSort] = useState("recent");
  const [grid, setGrid] = useState(true);
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
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null);
  const [toast, setToast] = useState("");
  const [pageLimit, setPageLimit] = useState(40);
  const [dense, setDense] = useState(false);
  const [contentScrollbarWidth, setContentScrollbarWidth] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const current = trackMap.get(currentId)!;
  const currentAlbum = albumMap.get(current.albumId)!;
  const currentIndex = queue.findIndex((track) => track.id === currentId);
  const pageRoute = route === "playing" ? backgroundRoute.current : route;
  const [section, routeId] = pageRoute.split("/");
  const searching = query.trim().length > 0;

  function announce(message: string) { setToast(""); window.setTimeout(() => setToast(message), 0); }
  function navigate(next: string) {
    setQuery(""); setMenu(null); setPageLimit(40); setMobileNavOpen(false); setFilter("全部");
    if (route !== "playing") backgroundRoute.current = route;
    window.location.hash = `/${next}`;
  }
  function openPlayer() { backgroundRoute.current = pageRoute; setQueueOpen(false); window.location.hash = "/playing"; }
  function closePlayer() { window.location.hash = `/${backgroundRoute.current === "playing" ? "home" : backgroundRoute.current}`; }
  function play(track: Track, source?: Track[]) {
    if (source?.length) setQueue(source);
    else if (!queue.some((item) => item.id === track.id)) setQueue((items) => [...items, track]);
    setCurrentId(track.id); setPosition(0); setIsPlaying(true);
  }
  function togglePlay() { setIsPlaying((value) => !value); }
  function nextTrack(auto = false) {
    if (!queue.length) return;
    if (auto && repeat === 2) { setPosition(0); return; }
    const index = queue.findIndex((track) => track.id === currentId);
    if (auto && index >= queue.length - 1 && repeat === 0 && !shuffle) { setIsPlaying(false); setPosition(current.duration); return; }
    const next = shuffle && queue.length > 1 ? (index + 1 + Math.floor(Math.random() * (queue.length - 1))) % queue.length : (index + 1) % queue.length;
    play(queue[next]);
  }
  function previousTrack() {
    if (position > 3) { setPosition(0); return; }
    play(queue[(Math.max(currentIndex, 0) - 1 + queue.length) % queue.length] ?? current);
  }
  function toggleFavorite(id: string) {
    setFavorites((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
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
    setPlaylists((items) => [...items, playlist]); setNewPlaylistName(""); setPlaylistError(""); setModal(null); navigate(`playlist/${playlist.id}`); announce("新歌单已创建");
  }
  function addToPlaylist(id: string, trackId: string) {
    const playlist = playlists.find((item) => item.id === id)!;
    if (playlist.trackIds.includes(trackId)) { announce("这首歌已经在歌单里了"); setModal(null); return; }
    setPlaylists((items) => items.map((item) => item.id === id ? { ...item, trackIds: [...item.trackIds, trackId] } : item));
    setModal(null); announce(`已加入「${playlist.name}」`);
  }
  function moveQueue(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= queue.length) return;
    setQueue((previous) => { const next = [...previous]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  }

  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    // Match the search edge to the content across overlay and classic scrollbars.
    const syncScrollbarWidth = () => setContentScrollbarWidth(main.offsetWidth - main.clientWidth);
    const observer = new ResizeObserver(syncScrollbarWidth);
    observer.observe(main);
    syncScrollbarWidth();
    return () => observer.disconnect();
  }, []);
  useEffect(() => { const update = () => { setRoute(readRoute()); setPageLimit(40); setMenu(null); }; window.addEventListener("hashchange", update); return () => window.removeEventListener("hashchange", update); }, []);
  useEffect(() => { if (route !== "playing" && previousPage.current !== pageRoute) mainRef.current?.scrollTo({ top: 0 }); previousPage.current = pageRoute; }, [route, pageRoute]);
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(""), 3200); return () => window.clearTimeout(id); }, [toast]);
  useEffect(() => { if (!isPlaying) return; const timer = window.setInterval(() => setPosition((value) => Math.min(value + 1, current.duration)), 1000); return () => window.clearInterval(timer); }, [isPlaying, current.duration]);
  useEffect(() => { if (isPlaying && position >= current.duration) nextTrack(true); }, [position, current.duration, isPlaying]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) { event.preventDefault(); searchRef.current?.focus(); return; }
      if (event.key === "Escape") { setMenu(null); setMobileNavOpen(false); if (searching && !document.querySelector("dialog[open]")) setQuery(""); }
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) || target.isContentEditable || modal || queueOpen) return;
      if (event.code === "Space") { event.preventDefault(); togglePlay(); }
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [modal, queueOpen, searching]);
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
      <div className="album-cover-wrap">
        <button className="cover-link" onClick={() => navigate(`album/${album.id}`)} aria-label={`打开专辑 ${album.name}`}><Cover album={album} /></button>
        <button className="cover-play" aria-label={`播放专辑 ${album.name}`} onClick={() => play(albumTracks(album.id)[0], albumTracks(album.id))}><Play fill="currentColor" /></button>
        <span className="cover-format">无损</span>
      </div>
      <button className="album-name" title={album.title} onClick={() => navigate(`album/${album.id}`)}>{album.name}</button>
      <p>{album.artist}</p><span className="album-year">{album.year} · {album.genre}</span>
    </article>;
  }
  function trackList(list: Track[], options: { compact?: boolean; hideAlbum?: boolean; playlistId?: string; limit?: number } = {}) {
    const visible = list.slice(0, options.limit ?? pageLimit);
    return <div className={`track-list ${options.compact ? "compact" : ""} ${options.hideAlbum ? "hide-album" : ""}`}>
      {!options.compact && list.length > 0 && <div className="track-table-head"><span>#</span><span>歌曲 / 艺人</span>{!options.hideAlbum && <span>专辑</span>}<span>音质</span><span><Clock3 size={14} /><span className="sr-only">时长</span></span><span /></div>}
      {visible.map((track, index) => {
        const album = albumMap.get(track.albumId)!;
        const active = track.id === currentId;
        return <div className={`track-row ${active ? "current-track" : ""}`} key={track.id}>
          <button className="track-number" aria-label={`${active && isPlaying ? "暂停" : "播放"} ${displayTitle(track)}`} onClick={() => active ? togglePlay() : play(track, list)}>
            {active ? isPlaying ? <span className="equalizer" aria-hidden="true"><i /><i /><i /></span> : <Pause size={14} /> : <><span>{String(index + 1).padStart(2, "0")}</span><Play size={14} fill="currentColor" /></>}
          </button>
          <button className="track-identity" onClick={() => active ? togglePlay() : play(track, list)} title={track.title}>
            {!options.hideAlbum && <Cover album={album} />}
            <span><strong>{displayTitle(track)}</strong><small>{track.artist}</small></span>
          </button>
          {!options.hideAlbum && <button className="track-album" onClick={() => navigate(`album/${album.id}`)}>{album.name}</button>}
          <span className="quality-tag">{track.format}</span><span className="track-duration">{time(track.duration)}</span>
          <div className="track-actions"><IconButton label={favorites.has(track.id) ? `取消收藏 ${displayTitle(track)}` : `收藏 ${displayTitle(track)}`} active={favorites.has(track.id)} onClick={() => toggleFavorite(track.id)}><Heart fill={favorites.has(track.id) ? "currentColor" : "none"} /></IconButton>
            {options.playlistId ? <IconButton label={`从歌单移除 ${displayTitle(track)}`} onClick={() => { setPlaylists((items) => items.map((item) => item.id === options.playlistId ? { ...item, trackIds: item.trackIds.filter((id) => id !== track.id) } : item)); announce("已从歌单移除"); }}><X /></IconButton> : <button className="icon-button track-more" aria-label={`${displayTitle(track)} 的更多操作`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ track, x: Math.min(rect.right - 210, window.innerWidth - 226), y: Math.min(rect.bottom + 4, window.innerHeight - 235) }); }}><MoreHorizontal /></button>}
          </div>
        </div>;
      })}
      {!list.length && <div className="empty-state"><Music2 /><h3>这里还很安静</h3><p>去曲库找些喜欢的音乐吧。</p><button className="button primary" onClick={() => navigate("albums")}>浏览专辑 <ArrowRight /></button></div>}
      {!options.limit && list.length > pageLimit && <button className="load-more" onClick={() => setPageLimit((value) => value + 60)}>再显示 {Math.min(60, list.length - pageLimit)} 首 <ChevronDown /></button>}
    </div>;
  }
  function playlistCard(playlist: Playlist) {
    return <button className="playlist-card" key={playlist.id} onClick={() => navigate(`playlist/${playlist.id}`)}>
      <PlaylistArt playlist={playlist} /><div><small>私人歌单 · {playlist.trackIds.length} 首</small><h3>{playlist.name}</h3><p>{playlist.description}</p></div><ArrowUpRight className="playlist-arrow" />
    </button>;
  }
  function pageHeading(kicker: string, title: string, description: string, action?: ReactNode) {
    return <div className="page-heading"><div><span className="eyebrow">{kicker}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;
  }
  function playButton(list: Track[], label = "播放全部") {
    return <button className="button primary" disabled={!list.length} onClick={() => play(list[0], list)}><Play size={16} fill="currentColor" />{label}</button>;
  }
  function renderHome() {
    return <>
      <div className="home-intro"><span className="eyebrow">你的音乐空间</span><h1>音乐，刚刚好。</h1><p>留一点时间，给喜欢的声音。</p></div>
      <section className="home-highlights" aria-label="聆听推荐">
        <article className="surface-card featured-record">
          <div className="featured-copy">
            <span className="featured-kicker"><Disc3 />今日精选</span>
            <h2>{featured.name}</h2>
            <p className="featured-credit">{featured.artist} · {featured.year}</p>
            <p className="featured-description">从熟悉的旋律出发，<br />重返故事里的世界。</p>
            <div className="featured-actions">
              <button className="button primary" onClick={() => play(albumTracks(featured.id)[0], albumTracks(featured.id))}><Play size={16} fill="currentColor" />播放专辑</button>
              <button className="text-button" onClick={() => navigate(`album/${featured.id}`)}>查看专辑<ChevronRight /></button>
            </div>
          </div>
          <button className="featured-artwork" aria-label={`查看今日精选 ${featured.name}`} onClick={() => navigate(`album/${featured.id}`)}><Cover album={featured} lazy={false} /></button>
        </article>
        <article className="surface-card resume-card">
          <div className="resume-heading"><span>继续聆听</span><Headphones /></div>
          <button className="resume-artwork" aria-label={`查看正在播放的专辑 ${currentAlbum.name}`} onClick={() => navigate(`album/${currentAlbum.id}`)}><Cover album={currentAlbum} lazy={false} /></button>
          <div className="resume-details"><strong title={current.title}>{displayTitle(current)}</strong><span>{current.artist}</span></div>
          <IconButton className="resume-control" label={isPlaying ? "暂停当前歌曲" : "继续播放"} onClick={togglePlay}>{isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</IconButton>
          <div className="resume-progress" aria-hidden="true"><span style={{ width: `${position / current.duration * 100}%` }} /></div>
        </article>
      </section>
      <section className="home-albums">{sectionHeading("最近加入", "每一次收藏，都值得认真听见。", <button className="text-button" onClick={() => navigate("albums")}>全部专辑<ChevronRight /></button>)}<div className="album-grid home-album-grid">{albums.slice(0, 5).map(albumCard)}</div></section>
      <section className="home-playlists">{sectionHeading("为不同的时刻", "你的生活，自己的配乐。", <button className="text-button" onClick={() => navigate("playlists")}>我的歌单<ChevronRight /></button>)}<div className="playlist-grid">{playlists.slice(0, 3).map(playlistCard)}</div></section>
      <section className="home-collection">
        <div>{sectionHeading("一听，就很喜欢", "让这些旋律多陪你一会儿。", <button className="text-button" onClick={() => navigate("favorites")}>全部收藏<ChevronRight /></button>)}<div className="surface-card home-favorites-list">{trackList(tracks.filter((track) => favorites.has(track.id)).slice(0, 4), { compact: true, limit: 4 })}</div></div>
        <aside className="surface-card library-summary"><span className="eyebrow">本地音乐库</span><h3>你的音乐，都在这里。</h3><div className="library-summary-stats"><div><strong>{tracks.length.toLocaleString()}</strong><span>首歌曲</span></div><div><strong>{albums.length}</strong><span>张专辑</span></div></div><p>{durationLabel(tracks.reduce((sum, track) => sum + track.duration, 0))}，慢慢听。</p><button className="text-button" onClick={() => setModal({ type: "info" })}>关于这间音乐室<ChevronRight /></button></aside>
      </section>
      <footer className="page-footer"><Disc3 size={15} /><span>你的音乐，你的节奏。</span><span>Music Library</span></footer>
    </>;
  }
  function renderAlbums() {
    let result = albums.filter((album) => filter === "全部" || album.genre === filter || (filter === "2020 年后" && album.year >= 2020));
    if (sort === "title") result = [...result].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    if (sort === "year") result = [...result].sort((a, b) => b.year - a.year);
    return <>{pageHeading("THE RECORD COLLECTION", "你的唱片架", `${albums.length} 张专辑，收藏着不同的世界。`, <button className="button subtle" onClick={() => play(tracks[Math.floor(Math.random() * tracks.length)], tracks)}><Shuffle /> 随心听听</button>)}
      <div className="collection-toolbar"><div className="filter-pills">{["全部", "游戏原声", "摇滚", "2020 年后"].map((item) => <button key={item} aria-pressed={filter === item} className={filter === item ? "selected" : ""} onClick={() => setFilter(item)}>{item}</button>)}</div><div className="view-controls"><label className="sort-control"><SlidersHorizontal size={14} /><select aria-label="专辑排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="recent">收藏顺序</option><option value="year">发行年份</option><option value="title">专辑名称</option></select></label><span className="control-separator" /><IconButton label="网格视图" active={grid} onClick={() => setGrid(true)}><Grid2X2 /></IconButton><IconButton label="列表视图" active={!grid} onClick={() => setGrid(false)}><List /></IconButton></div></div>
      {grid ? <div className="album-grid collection-grid">{result.map(albumCard)}</div> : <div className="album-list">{result.map((album) => <button key={album.id} onClick={() => navigate(`album/${album.id}`)}><Cover album={album} /><span><strong>{album.name}</strong><small>{album.artist}</small></span><span>{album.year}</span><span>{album.trackCount} 首</span><ChevronRight /></button>)}</div>}
    </>;
  }
  function renderAlbum(album?: Album) {
    if (!album) return renderNotFound();
    const list = albumTracks(album.id);
    const discs = [...new Set(list.map((track) => track.disc))];
    const filtered = filter.startsWith("Disc ") ? list.filter((track) => track.disc === Number(filter.slice(5))) : list;
    return <><button className="back-link" onClick={() => navigate("albums")}><ArrowLeft /> 回到唱片架</button><section className="detail-hero" style={{ "--album-color": album.color } as CSSProperties}><Cover album={album} lazy={false} /><div><span className="eyebrow">专辑 · {album.year}</span><h1>{album.name}</h1><p className="original-title">{album.title}</p><button className="detail-artist" onClick={() => navigate(`artist/${encodeURIComponent(album.artist)}`)}>{album.artist}<ChevronRight /></button><p className="detail-meta">{album.trackCount} 首歌曲 <span>·</span> {durationLabel(album.duration)} <span>·</span><span className="lossless"><Disc3 /> 无损音质</span></p><div className="detail-actions">{playButton(list)}<button className="button subtle" onClick={() => { setShuffle(true); play(list[Math.floor(Math.random() * list.length)], list); }}><Shuffle /> 随机播放</button></div></div></section>
      {discs.length > 1 && <div className="filter-pills disc-tabs"><button className={filter === "全部" ? "selected" : ""} onClick={() => { setFilter("全部"); setPageLimit(40); }}>完整专辑</button>{discs.map((disc) => <button key={disc} className={filter === `Disc ${disc}` ? "selected" : ""} onClick={() => { setFilter(`Disc ${disc}`); setPageLimit(40); }}>Disc {disc}</button>)}</div>}
      {trackList(filtered, { hideAlbum: true })}<p className="detail-endnote">每一首，都有它自己的故事。 · {album.year}</p>
    </>;
  }
  function renderArtists() {
    const artistNames = [...new Set(albums.map((album) => album.artist))];
    return <>{pageHeading("BEHIND THE MUSIC", "旋律背后的人", "循着一个名字，听见更多喜欢的声音。")}
      <div className="artist-grid">{artistNames.map((name) => { const discography = albums.filter((album) => album.artist === name); return <button className="artist-card" key={name} onClick={() => navigate(`artist/${encodeURIComponent(name)}`)}><div className="artist-art"><Cover album={discography[0]} /><span><Music2 /></span></div><h2>{name}</h2><p>{discography.length} 张专辑 · {discography.reduce((sum, album) => sum + album.trackCount, 0)} 首歌曲</p></button>; })}</div></>;
  }
  function renderArtist(id: string) {
    let name = ""; try { name = decodeURIComponent(id); } catch { return renderNotFound(); }
    const artistAlbumIds = new Set(albums.filter((album) => album.artist === name).map((album) => album.id));
    const list = tracks.filter((track) => track.artist === name || artistAlbumIds.has(track.albumId));
    const resultAlbumIds = new Set(list.map((track) => track.albumId));
    const results = albums.filter((album) => resultAlbumIds.has(album.id));
    if (!results.length) return renderNotFound();
    return <><button className="back-link" onClick={() => navigate("artists")}><ArrowLeft /> 全部艺人</button>{pageHeading("ARTIST COLLECTION", name, `${results.length} 张专辑 · ${list.length} 首收藏的作品`, playButton(list))}<div className="album-grid collection-grid">{results.map(albumCard)}</div><section>{sectionHeading("从这些旋律开始")}{trackList(list, { limit: 12 })}</section></>;
  }
  function renderPlaylist(playlist?: Playlist) {
    if (!playlist) return renderNotFound();
    const list = playlist.trackIds.map((id) => trackMap.get(id)!).filter(Boolean);
    return <><button className="back-link" onClick={() => navigate("playlists")}><ArrowLeft /> 我的歌单</button><section className="detail-hero playlist-detail"><PlaylistArt playlist={playlist} /><div><span className="eyebrow">为自己收藏 · 私人歌单</span><h1>{playlist.name}</h1><p className="playlist-description">{playlist.description}</p><p className="detail-meta">{list.length} 首歌曲 · {durationLabel(list.reduce((sum, track) => sum + track.duration, 0))}</p><div className="detail-actions">{playButton(list)}<button className="button subtle" onClick={() => navigate("songs")}><Plus /> 添加歌曲</button></div></div></section>{trackList(list, { playlistId: playlist.id })}</>;
  }
  function renderSearch() {
    const term = query.trim().toLocaleLowerCase();
    const matchingAlbums = albums.filter((album) => `${album.name} ${album.title} ${album.artist} ${album.genre}`.toLocaleLowerCase().includes(term));
    const matchingTracks = tracks.filter((track) => `${track.title} ${track.artist} ${albumMap.get(track.albumId)?.name}`.toLocaleLowerCase().includes(term));
    return <>{pageHeading("FIND YOUR NEXT FAVORITE", `寻找「${query.trim()}」`, `${matchingAlbums.length} 张专辑 · ${matchingTracks.length} 首歌曲`)}
      {!matchingAlbums.length && !matchingTracks.length ? <div className="empty-state search-empty"><Search /><h3>还没有找到这段旋律</h3><p>试试「西木康智」「歧路旅人」或歌曲名称。</p><button className="button subtle" onClick={() => { setQuery(""); searchRef.current?.focus(); }}>重新搜索</button></div> : <>{matchingAlbums.length > 0 && <section className="search-albums">{sectionHeading("专辑")}<div className="album-grid collection-grid">{matchingAlbums.slice(0, 5).map(albumCard)}</div></section>}{matchingTracks.length > 0 && <section>{sectionHeading("歌曲", undefined, playButton(matchingTracks))}{trackList(matchingTracks)}</section>}</>}
    </>;
  }
  function renderNotFound() { return <div className="empty-state"><Disc3 /><h1>这张唱片暂时不在架上</h1><button className="button primary" onClick={() => navigate("home")}>回到音乐室</button></div>; }
  function renderPage() {
    if (searching) return renderSearch();
    if (section === "home") return renderHome();
    if (section === "albums") return renderAlbums();
    if (section === "album") return renderAlbum(albumMap.get(routeId));
    if (section === "artists") return renderArtists();
    if (section === "artist") return renderArtist(routeId);
    if (section === "playlist") return renderPlaylist(playlists.find((item) => item.id === routeId));
    if (section === "playlists") return <>{pageHeading("MADE BY YOU", "给生活，一点配乐", `${playlists.length} 张私人歌单，装着不同的心情。`, <button className="button primary" onClick={() => { setNewPlaylistName(""); setPlaylistError(""); setModal({ type: "create" }); }}><Plus /> 新建歌单</button>)}<div className="playlist-grid all-playlists">{playlists.map(playlistCard)}</div></>;
    if (section === "favorites") { const list = tracks.filter((track) => favorites.has(track.id)); return <><div className="favorites-banner"><span><Heart fill="currentColor" /></span><div><span className="eyebrow">ALWAYS A FAVORITE</span><h1>一听，就很喜欢</h1><p>{list.length} 首让你按下爱心的旋律。</p></div>{playButton(list)}</div>{trackList(list)}</>; }
    if (section === "songs") { const list = tracks.filter((track) => filter === "全部" || track.format === filter); return <>{pageHeading("EVERY NOTE BELONGS HERE", "所有歌曲", `${tracks.length.toLocaleString()} 首旋律，随时为你响起。`, playButton(list))}<div className="collection-toolbar"><div className="filter-pills">{["全部", "FLAC", "ALAC"].map((item) => <button key={item} className={filter === item ? "selected" : ""} onClick={() => { setFilter(item); setPageLimit(40); }}>{item}</button>)}</div><span className="result-count">{list.length.toLocaleString()} 首歌曲</span></div>{trackList(list)}</>; }
    return renderNotFound();
  }
  function queueContent() {
    return <div className="queue-content"><div className="queue-current"><span className="eyebrow">正在播放</span><div><Cover album={currentAlbum} /><span><strong>{displayTitle(current)}</strong><small>{current.artist}</small></span>{isPlaying && <span className="equalizer"><i /><i /><i /></span>}</div></div><div className="queue-section-label"><span>待播清单 <small>{queue.length} 首</small></span><button onClick={() => { setQueue([current]); announce("已清空其他待播歌曲"); }} disabled={queue.length <= 1}>清空</button></div><div className="queue-tracks">{queue.map((track, index) => <div className={`queue-row ${track.id === currentId ? "current" : ""}`} key={track.id}><button className="queue-track-select" onClick={() => play(track)}><span className="queue-number">{track.id === currentId ? <Music2 size={13} /> : String(index + 1).padStart(2, "0")}</span><Cover album={albumMap.get(track.albumId)!} /><span><strong>{displayTitle(track)}</strong><small>{track.artist}</small></span></button><div className="queue-row-actions"><IconButton label={`上移 ${displayTitle(track)}`} disabled={index === 0} onClick={() => moveQueue(index, -1)}><ArrowUp /></IconButton><IconButton label={`下移 ${displayTitle(track)}`} disabled={index === queue.length - 1} onClick={() => moveQueue(index, 1)}><ArrowDown /></IconButton>{track.id !== currentId && <IconButton label={`移除 ${displayTitle(track)}`} onClick={() => setQueue((items) => items.filter((item) => item.id !== track.id))}><X /></IconButton>}</div></div>)}</div></div>;
  }

  return <div className={`app ${isMobile ? "mobile-layout" : "desktop-layout"} ${dense ? "dense-layout" : ""} library-surface ${section === "home" && !searching ? "home-surface" : ""}`}>
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }}>跳到主要内容</a>
    <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`} aria-label="音乐库导航" inert={isMobile && !mobileNavOpen}>
      <button className="brand" aria-label="Music Library 首页" onClick={() => navigate("home")}><span className="brand-mark"><Disc3 /></span><span>Music Library</span></button>
      {isMobile && <IconButton className="close-mobile-nav" label="关闭导航" onClick={() => setMobileNavOpen(false)}><X /></IconButton>}
      <div className="sidebar-content">
        <span className="nav-label">我的音乐</span><nav className="main-nav">{navItems.map(({ route: target, title, icon: Icon }) => <button key={target} aria-label={title} aria-current={!searching && (section === target || section === target.replace(/s$/, "")) ? "page" : undefined} onClick={() => navigate(target)}><Icon /><span>{title}</span>{target === "favorites" && <small>{favorites.size}</small>}</button>)}<button className="compact-playlists" aria-label="我的歌单" aria-current={!searching && (section === "playlists" || section === "playlist") ? "page" : undefined} onClick={() => navigate("playlists")}><ListMusic /><span>我的歌单</span></button></nav>
        <div className="playlist-nav-heading"><button className="nav-label" onClick={() => navigate("playlists")}>我的歌单</button><IconButton label="新建歌单" onClick={() => { setNewPlaylistName(""); setPlaylistError(""); setModal({ type: "create" }); }}><Plus /></IconButton></div>
        <nav className="playlist-nav">{playlists.map((playlist) => <button key={playlist.id} aria-current={routeId === playlist.id ? "page" : undefined} onClick={() => navigate(`playlist/${playlist.id}`)}><div className="sidebar-playlist-art" aria-hidden="true"><PlaylistArt playlist={playlist} /></div><ListMusic /><span>{playlist.name}</span></button>)}</nav>
      </div>
      <div className="sidebar-bottom"><div className="local-library"><span className="status-dot" /><div><strong>本地音乐库</strong><span>{tracks.length.toLocaleString()} 首 · {albums.length} 张专辑</span></div><Disc3 /></div><button className="settings-button" aria-label="音乐室设置" onClick={() => setModal({ type: "settings" })}><Settings2 /> 设置 <ChevronRight /></button></div>
    </aside>
    {isMobile && mobileNavOpen && <button className="nav-backdrop" aria-label="收起导航" onClick={() => setMobileNavOpen(false)} />}
    <div className="workspace" style={{ "--content-scrollbar-width": `${contentScrollbarWidth}px` } as CSSProperties}>
      <header className="topbar">
        {isMobile && <div className="breadcrumbs"><IconButton label="打开导航" onClick={() => setMobileNavOpen(true)}><Library /></IconButton></div>}
        <label className="search-field"><Search /><input ref={searchRef} value={query} placeholder="找一首歌、一张专辑、一位艺人" aria-label="搜索歌曲、专辑、艺人" onChange={(event) => { setQuery(event.target.value); setPageLimit(40); }} />{query ? <button aria-label="清空搜索" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X /></button> : <kbd>⌘ K</kbd>}</label>
      </header>
      <main ref={mainRef} id="main-content" className="main-content" tabIndex={-1}><div className="page-content" key={searching ? "search" : pageRoute}>{renderPage()}</div></main>
    </div>
    <CapsulePlayer
      title={current.title} artist={current.artist} album={currentAlbum.title} cover={currentAlbum.cover}
      isMobile={isMobile} playing={isPlaying} position={position} duration={current.duration}
      volume={volume} shuffle={shuffle} repeat={repeat} queueOpen={queueOpen}
      onTogglePlay={togglePlay} onPrevious={previousTrack} onNext={() => nextTrack()}
      onToggleShuffle={() => setShuffle((value) => !value)}
      onToggleRepeat={() => setRepeat((value) => ((value + 1) % 3) as 0 | 1 | 2)}
      onSeek={setPosition} onVolumeChange={setVolume} onOpenPlayer={openPlayer}
      onOpenQueue={() => setQueueOpen(true)}
      onOpenArtist={() => navigate(`artist/${encodeURIComponent(current.artist)}`)}
      onOpenAlbum={() => navigate(`album/${currentAlbum.id}`)}
    />
    {queueOpen && <Modal className="queue-dialog" label="待播清单" onClose={() => setQueueOpen(false)}><div className="dialog-heading"><div><span className="eyebrow">KEEP THE MUSIC GOING</span><h2>接下来听</h2></div><IconButton label="关闭待播清单" onClick={() => setQueueOpen(false)}><X /></IconButton></div>{queueContent()}</Modal>}
    {route === "playing" && <Modal className="now-playing-dialog" label="沉浸播放器" onClose={closePlayer}>
      <NowPlaying
        track={{ ...current, title: displayTitle(current), cover: currentAlbum.cover }} album={currentAlbum}
        queue={queue.map((track) => ({ ...track, title: displayTitle(track), cover: albumMap.get(track.albumId)!.cover }))}
        isMobile={isMobile} playing={isPlaying} position={position} volume={volume}
        favorite={favorites.has(currentId)} shuffle={shuffle} repeat={repeat}
        onClose={closePlayer} onTogglePlay={togglePlay} onPrevious={previousTrack} onNext={() => nextTrack()}
        onSeek={setPosition} onVolumeChange={setVolume} onToggleFavorite={() => toggleFavorite(currentId)}
        onToggleShuffle={() => setShuffle((value) => !value)}
        onToggleRepeat={() => setRepeat((value) => ((value + 1) % 3) as 0 | 1 | 2)}
        onOpenAlbum={() => navigate(`album/${currentAlbum.id}`)}
        onOpenArtist={() => navigate(`artist/${encodeURIComponent(current.artist)}`)}
        onSelectTrack={(id) => play(trackMap.get(id)!)} onMoveTrack={moveQueue}
        onRemoveTrack={(id) => setQueue((items) => items.filter((item) => item.id !== id))}
        onClearQueue={() => setQueue([current])}
      />
    </Modal>}
    {modal && <Modal className="standard-dialog" label={modal.type === "create" ? "新建歌单" : modal.type === "add" ? "添加到歌单" : modal.type === "settings" ? "音乐室设置" : "关于原型"} onClose={() => setModal(null)}><div className="dialog-heading"><span className="dialog-symbol">{modal.type === "create" || modal.type === "add" ? <ListMusic /> : modal.type === "settings" ? <Settings2 /> : <Disc3 />}</span><IconButton label="关闭对话框" onClick={() => setModal(null)}><X /></IconButton></div>
      {modal.type === "create" && <form onSubmit={(event) => { event.preventDefault(); createPlaylist(); }}><h2>给心情，一张歌单</h2><p>装下某个时刻，也收藏某种喜欢。</p><label className="form-field">歌单名称<input autoFocus value={newPlaylistName} maxLength={60} placeholder="比如：星期天的午后" aria-invalid={Boolean(playlistError)} aria-describedby={playlistError ? "playlist-error" : undefined} onChange={(event) => { setNewPlaylistName(event.target.value); setPlaylistError(""); }} /></label>{playlistError && <p className="form-error" id="playlist-error" role="alert">{playlistError}</p>}<div className="dialog-actions"><button type="button" className="button subtle" onClick={() => setModal(null)}>再想想</button><button type="submit" className="button primary"><Plus /> 创建歌单</button></div></form>}
      {modal.type === "add" && <><h2>收藏到哪张歌单？</h2><p>{displayTitle(trackMap.get(modal.trackId)!)}</p><div className="add-playlist-list">{playlists.map((playlist) => <button key={playlist.id} onClick={() => addToPlaylist(playlist.id, modal.trackId)}><PlaylistArt playlist={playlist} /><span><strong>{playlist.name}</strong><small>{playlist.trackIds.length} 首歌曲</small></span>{playlist.trackIds.includes(modal.trackId) ? <Check /> : <Plus />}</button>)}</div><button className="button subtle full-width" onClick={() => { setNewPlaylistName(""); setPlaylistError(""); setModal({ type: "create", trackId: modal.trackId }); }}><Plus /> 创建新歌单</button></>}
      {modal.type === "info" && <><span className="eyebrow">MUSIC LIBRARY · DESIGN CONCEPT 01</span><h2>属于你的，私人音乐空间</h2><p>以唱片收藏为灵感，让浏览、发现与聆听都慢下来。</p><div className="about-stats"><span><strong>{tracks.length.toLocaleString()}</strong>首歌曲</span><span><strong>{albums.length}</strong>张真实专辑</span><span><strong>01</strong>私人音乐室</span></div><div className="prototype-explanation"><Info /><p>这是独立交互原型，使用本地曲库的元数据与封面快照。播放、进度及音量为交互演示，不输出音频；收藏和歌单在刷新后重置。原曲库与现有应用保持不变。</p></div><button className="button primary full-width" onClick={() => setModal(null)}>开始逛逛 <ArrowRight /></button></>}
      {modal.type === "settings" && <><h2>音乐室设置</h2><p>把这里调成你喜欢的样子。</p><div className="setting-row"><span><strong>紧凑歌曲列表</strong><small>在同一屏里看见更多音乐</small></span><button className={`toggle ${dense ? "on" : ""}`} role="switch" aria-checked={dense} aria-label="紧凑歌曲列表" onClick={() => setDense((value) => !value)}><span /></button></div><div className="setting-row"><span><strong>曲库快照</strong><small>{tracks.length.toLocaleString()} 首歌曲 · {albums.length} 张专辑</small></span><span className="setting-badge">已载入</span></div><div className="prototype-explanation"><Info /><p>当前预览使用独立数据快照。扫描、文件管理与账号设置将在正式接入时沿用现有服务。</p></div><button className="button primary full-width" onClick={() => setModal(null)}>就这样，很好</button></>}
    </Modal>}
    {menu && <><button className="menu-backdrop" aria-label="关闭歌曲操作菜单" onClick={() => setMenu(null)} /><div className="track-menu" role="menu" aria-label="歌曲操作" style={{ left: Math.max(12, menu.x), top: Math.max(12, menu.y) }}><button role="menuitem" autoFocus onClick={() => enqueue(menu.track, true)}><SkipForward /> 下一首播放</button><button role="menuitem" onClick={() => enqueue(menu.track)}><ListMusic /> 加入待播清单</button><button role="menuitem" onClick={() => { setModal({ type: "add", trackId: menu.track.id }); setMenu(null); }}><Plus /> 添加到歌单</button><button role="menuitem" onClick={() => { toggleFavorite(menu.track.id); setMenu(null); }}><Heart />{favorites.has(menu.track.id) ? "取消收藏" : "收藏歌曲"}</button><button role="menuitem" onClick={() => navigate(`album/${menu.track.albumId}`)}><Disc3 /> 前往专辑</button></div></>}
    <div className={`toast ${toast ? "visible" : ""}`} role="status" aria-live="polite">{toast && <><Check size={16} />{toast}</>}</div>
  </div>;
}
