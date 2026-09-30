import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Disc3, FastForward, Heart, ListMusic, MessageSquareText, MoreHorizontal, LoaderCircle, AlertTriangle, Pause, Play, Repeat, Repeat1, Rewind, Shuffle, Volume2, VolumeX, X } from "lucide-react";
import { DemoLyrics } from "./DemoLyrics";

import { Artwork, PlaybackFeedback } from "./StateComponents";
import { playbackBusy, type PlaybackPhase } from "./prototype-state";

type PlayerTrack = { id: string; title: string; artist: string; duration: number; format: string; cover: string };
type PlayerPanel = "lyrics" | "queue";
type NowPlayingProps = {
  phase: PlaybackPhase;
  onRetry: () => void;
  initialPanel?: PlayerPanel;
  initialLyrics?: "ready" | "loading" | "error" | "empty";
  track: PlayerTrack;
  album: { name: string; title: string; year: number };
  queue: PlayerTrack[];
  isMobile: boolean;
  playing: boolean;
  position: number;
  volume: number;
  favorite: boolean;
  shuffle: boolean;
  repeat: 0 | 1 | 2;
  onClose: () => void;
  onTogglePlay: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (position: number) => void;
  onVolumeChange: (volume: number) => void;
  onToggleFavorite: () => void;
  onToggleShuffle: () => void;
  onToggleRepeat: () => void;
  onOpenAlbum: () => void;
  onOpenArtist: () => void;
  onSelectTrack: (id: string) => void;
  onMoveTrack: (index: number, offset: number) => void;
  onRemoveTrack: (id: string) => void;
  onClearQueue: () => void;
};

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
function Control({ label, children, onClick, active, disabled, className = "" }: {
  label: string; children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean; className?: string;
}) {
  return <button type="button" className={`np-icon ${className} ${active ? "selected" : ""}`} aria-label={label} title={label} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function NowPlaying(props: NowPlayingProps) {
  const { track, album, queue, playing, position, volume, favorite, shuffle, repeat, isMobile } = props;
  const [panel, setPanel] = useState<PlayerPanel | null>(props.initialPanel ?? null);
  const [lyricsStatus, setLyricsStatus] = useState(props.initialLyrics ?? "ready");
  const showDemoLyrics = lyricsStatus === "ready";
  const [lyricsHeld, setLyricsHeld] = useState(props.initialLyrics === "loading");
  const lyricsTimer = useRef<number | null>(null);
  useEffect(() => () => { if (lyricsTimer.current) window.clearTimeout(lyricsTimer.current); }, []);
  useEffect(() => { if (!props.initialLyrics || props.initialLyrics === "ready") setLyricsStatus("ready"); }, [track.id, props.initialLyrics]);
  function loadLyrics() { setLyricsHeld(false); setLyricsStatus("loading"); lyricsTimer.current = window.setTimeout(() => setLyricsStatus("ready"), 850); }
  const busy = playbackBusy(props.phase);
  const showPlaybackFeedback = props.phase !== "ready" && props.phase !== "transcoding";
  const [editingTrack, setEditingTrack] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panelButtons = useRef<Partial<Record<PlayerPanel, HTMLButtonElement | null>>>({});
  const lastVolume = useRef(volume || 70);
  const currentIndex = queue.findIndex((item) => item.id === track.id);
  const upcoming = queue.slice(currentIndex + 1);
  const repeatLabel = ["顺序播放，点击切换列表循环", "列表循环，点击切换单曲循环", "单曲循环，点击切换顺序播放"][repeat];
  const progressStyle = { "--progress": `${track.duration ? position / track.duration * 100 : 0}%` } as CSSProperties;

  function changeLayout(update: () => void) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { update(); return; }
    // Keep the animation inside the player; document snapshots can expose offscreen page content.
    const elements = Array.from(stageRef.current?.querySelectorAll<HTMLElement>(".np-artwork, .np-metadata, .np-playback") ?? []);
    const previous = elements.map((element) => element.getBoundingClientRect());
    elements.forEach((element) => element.getAnimations().forEach((animation) => animation.cancel()));
    flushSync(update);
    elements.forEach((element, index) => {
      const before = previous[index];
      const after = element.getBoundingClientRect();
      if (!before.width || !after.width || !before.height || !after.height) return;
      const x = before.left + before.width / 2 - after.left - after.width / 2;
      const y = before.top + before.height / 2 - after.top - after.height / 2;
      const transform = getComputedStyle(element).transform;
      element.animate([
        { transform: `translate(${x}px, ${y}px) scale(${before.width / after.width}, ${before.height / after.height}) ${transform === "none" ? "" : transform}` },
        { transform }
      ], { duration: 480, easing: "cubic-bezier(.22,.75,.25,1)" });
    });
  }
  function closePanel() {
    if (panel) panelButtons.current[panel]?.focus();
    changeLayout(() => setPanel(null));
  }
  function togglePanel(nextPanel: PlayerPanel) { changeLayout(() => setPanel((current) => current === nextPanel ? null : nextPanel)); }
  function toggleMute() {
    if (volume > 0) lastVolume.current = volume;
    props.onVolumeChange(volume > 0 ? 0 : lastVolume.current);
  }

  return <div className={`now-playing-screen ${isMobile ? "np-mobile" : ""} ${playing ? "np-is-playing" : ""} ${showPlaybackFeedback ? "np-has-feedback" : ""} ${panel === "queue" || (panel === "lyrics" && lyricsStatus !== "empty") ? "np-with-panel" : ""} ${panel === "lyrics" && lyricsStatus === "empty" ? "np-lyrics-open" : ""}`} onKeyDownCapture={(event) => {
    if (event.key === "Escape" && panel) { event.preventDefault(); event.stopPropagation(); closePanel(); }
  }}>
    <div className="np-atmosphere" aria-hidden="true">{track.cover && <><img key={track.cover} src={track.cover} alt="" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /><img key={`${track.cover}-wash`} src={track.cover} alt="" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /></>}<div /></div>
    <header className="np-header">
      <button className="np-back" onClick={props.onClose} aria-label="收起播放器" title="收起播放器"><ChevronDown /><span>返回音乐库</span></button>
      <div className="np-header-title"><span>正在聆听</span><button onClick={props.onOpenAlbum}>{album.name}</button></div>
      <span className="np-demo" title="独立交互原型，播放操作不输出音频">交互演示</span>
    </header>

    <div className="np-stage" ref={stageRef}>
      <div className={`np-artwork ${playing ? "is-playing" : ""}`}><Artwork src={track.cover} alt={`${album.name} 专辑封面`} lazy={false} /></div>

      <div className="np-metadata">
        <div className="np-title-row"><h1 title={track.title}>{track.title}</h1><Control className="np-favorite" label={favorite ? "取消收藏当前歌曲" : "收藏当前歌曲"} active={favorite} onClick={props.onToggleFavorite}><Heart fill={favorite ? "currentColor" : "none"} /></Control></div>
        <div className="np-artist-line"><button className="np-artist" onClick={props.onOpenArtist}><span>{track.artist}</span><ChevronRight /></button></div>
      </div>

      <div className="np-playback">
        <div className="np-progress">
          <input type="range" disabled={props.phase !== "ready"} min="0" max={track.duration} value={position} aria-label="播放进度" aria-valuetext={`${time(position)}，共 ${time(track.duration)}`} style={progressStyle} onChange={(event) => props.onSeek(Number(event.currentTarget.value))} />
          <div aria-hidden="true"><span>{time(position)}</span><span>−{time(Math.max(0, track.duration - position))}</span></div>
        </div>
        <div className="np-transport">
          <Control className="np-skip" label="上一首" onClick={props.onPrevious}><Rewind /></Control>
          <Control className="np-play" disabled={busy} label={busy ? "正在准备音频" : playing ? "暂停" : "播放"} onClick={props.onTogglePlay}>{busy ? <LoaderCircle className="button-spinner" /> : playing ? <Pause /> : <Play />}</Control>
          <Control className="np-skip" label="下一首" onClick={props.onNext}><FastForward /></Control>
        </div>
        <div className="np-utilities">
          <button ref={(element) => { panelButtons.current.lyrics = element; }} type="button" className="np-icon np-panel-toggle np-state-toggle" aria-label="歌词" title={panel === "lyrics" ? "收起歌词" : "展开歌词"} aria-pressed={panel === "lyrics"} aria-expanded={panel === "lyrics"} aria-controls={panel === "lyrics" ? "np-companion" : undefined} onClick={() => togglePanel("lyrics")}><MessageSquareText /></button>
          <div className="np-volume"><Control label={volume ? "静音" : "恢复音量"} onClick={toggleMute}>{volume ? <Volume2 /> : <VolumeX />}</Control><input type="range" min="0" max="100" value={volume} aria-label="音量" aria-valuetext={`${volume}%`} style={{ "--progress": `${volume}%` } as CSSProperties} onChange={(event) => props.onVolumeChange(Number(event.currentTarget.value))} /></div>
          <span className="np-quality" title="当前曲目的音频格式"><Disc3 />{track.format} 无损</span>
          <button ref={(element) => { panelButtons.current.queue = element; }} type="button" className="np-icon np-panel-toggle np-state-toggle" aria-label="待播清单" title={panel === "queue" ? "收起待播清单" : `展开待播清单，${upcoming.length} 首`} aria-pressed={panel === "queue"} aria-expanded={panel === "queue"} aria-controls={panel === "queue" ? "np-companion" : undefined} onClick={() => togglePanel("queue")}><ListMusic /></button>
        </div>
        {showPlaybackFeedback && <PlaybackFeedback phase={props.phase} onRetry={props.onRetry} onNext={props.onNext} />}
      </div>

      {panel && <section className={`np-companion ${panel === "lyrics" && lyricsStatus === "empty" ? "np-lyrics-notice" : ""}`} id="np-companion" aria-label={panel === "lyrics" ? "歌词" : undefined} aria-labelledby={panel === "queue" ? "np-companion-title" : undefined}>
        {panel === "queue" && <div className="np-panel-heading"><div><h2 id="np-companion-title">接下来播放<small>{upcoming.length} 首</small></h2></div><div className="np-queue-modes"><Control className="np-state-toggle" label={shuffle ? "关闭随机播放" : "随机播放"} active={shuffle} onClick={props.onToggleShuffle}><Shuffle /></Control><Control className="np-state-toggle" label={repeatLabel} active={repeat > 0} onClick={props.onToggleRepeat}>{repeat === 2 ? <Repeat1 /> : <Repeat />}</Control></div></div>}
        {panel === "queue" ? <>
          <div className="np-queue-summary"><span>{repeat === 2 ? "单曲循环中" : shuffle ? "随机播放已开启" : "按顺序播放"}</span><button disabled={!upcoming.length} onClick={props.onClearQueue}>清空待播</button></div>
          {upcoming.length ? <div className="np-queue-list">{upcoming.map((item, index) => {
            const sourceIndex = currentIndex + 1 + index;
            return <div className={`np-queue-item ${editingTrack === item.id ? "np-queue-editing" : ""}`} key={item.id}>
              <button className="np-queue-select" aria-label={`播放 ${item.title}`} onClick={() => props.onSelectTrack(item.id)}><span className="np-queue-number">{String(index + 1).padStart(2, "0")}</span><Artwork src={item.cover} alt={`${item.title} 封面`} /><span><strong>{item.title}</strong><small>{item.artist}</small></span><span className="np-queue-duration">{time(item.duration)}</span></button>
              <button type="button" className="np-icon np-queue-more" aria-label={`编辑待播歌曲 ${item.title}`} aria-expanded={editingTrack === item.id} onClick={() => setEditingTrack((current) => current === item.id ? null : item.id)}><MoreHorizontal /></button>
              <div className="np-queue-actions"><Control label={`上移 ${item.title}`} disabled={index === 0} onClick={() => props.onMoveTrack(sourceIndex, -1)}><ArrowUp /></Control><Control label={`下移 ${item.title}`} disabled={index === upcoming.length - 1} onClick={() => props.onMoveTrack(sourceIndex, 1)}><ArrowDown /></Control><Control label={`移除 ${item.title}`} onClick={() => props.onRemoveTrack(item.id)}><X /></Control></div>
            </div>;
          })}</div> : <div className="np-empty"><div className="np-empty-content">
            <span className="np-empty-icon" aria-hidden="true"><ListMusic /></span>
            <h3>听到这里，刚刚好</h3>
            <p>{repeat === 1 ? "本轮播放结束后，将从头循环。" : <>暂时没有待播歌曲<br />回曲库再挑些喜欢的音乐吧。</>}</p>
            <button type="button" className="np-empty-action" onClick={props.onClose}>回到音乐库</button>
          </div></div>}
        </> : lyricsStatus === "loading" || lyricsStatus === "error" ? <div className="np-lyrics-status is-request-state" role={lyricsStatus === "error" ? "alert" : "status"}>{lyricsStatus === "loading" ? <LoaderCircle className="button-spinner" /> : <AlertTriangle />}<strong>{lyricsStatus === "loading" ? "正在寻找这首歌的歌词" : "歌词暂时没有载入"}</strong><span>{lyricsStatus === "loading" ? "音乐会继续播放，请稍等片刻。" : "检查连接后重试，音乐播放不受影响。"}</span>{(lyricsStatus === "error" || lyricsHeld) && <button onClick={loadLyrics}>{lyricsStatus === "loading" ? "继续演示载入" : "重新载入歌词"}</button>}</div> : showDemoLyrics ? <DemoLyrics trackId={track.id} duration={track.duration} position={position} playing={playing} onSeek={props.onSeek} onShowEmpty={() => changeLayout(() => setLyricsStatus("empty"))} /> : <div className="np-lyrics-status" role="status"><MessageSquareText /><span>这首音乐暂未提供歌词</span><button type="button" onClick={() => changeLayout(() => setLyricsStatus("ready"))}>查看演示歌词</button></div>}
      </section>}
    </div>
  </div>;
}
