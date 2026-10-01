import { useRef, useState, type CSSProperties } from "react";
import { FastForward, ListMusic, LoaderCircle, Maximize2, Pause, Play, Rewind } from "lucide-react";
import { PlayerMarquee } from "../../../src/client/PlayerMarquee";
import { useSeekInput } from "../../../src/client/seek-input";
import { PlayerRepeatIcon, PlayerRepeatOneIcon, PlayerShuffleIcon, PlayerVolumeIcon } from "./PlayerIcons";

import { Artwork } from "./StateComponents";
import { playbackBusy, playbackCopy, type PlaybackPhase } from "./prototype-state";

type CapsulePlayerProps = {
  trackId?: string;
  phase?: PlaybackPhase;
  title: string;
  artist: string;
  album: string;
  cover: string;
  isMobile: boolean;
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: 0 | 1 | 2;
  queueOpen: boolean;
  onTogglePlay: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onToggleShuffle: () => void;
  onToggleRepeat: () => void;
  onSeek: (position: number) => void;
  onVolumeChange: (volume: number) => void;
  onOpenPlayer: () => void;
  onOpenQueue: () => void;
  onOpenArtist: () => void;
  onOpenAlbum: () => void;
};

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

// 外观沿用正式客户端，交互仍由原型的模拟播放状态驱动。
export function CapsulePlayer(props: CapsulePlayerProps) {
  const { title, artist, album, cover, isMobile, playing, position, duration, volume, shuffle, repeat } = props;
  const seekInput = useSeekInput({ position, duration, trackId: props.trackId, onSeek: props.onSeek });
  const seeking = seekInput.seeking;
  const [volumeExpanded, setVolumeExpanded] = useState(false);
  const [volumeDragging, setVolumeDragging] = useState(false);
  const lastVolume = useRef(volume || 70);
  const repeatLabel = ["顺序播放，点击切换列表循环", "列表循环，点击切换单曲循环", "单曲循环，点击切换顺序播放"][repeat];
  const coverImage = <Artwork src={cover} alt={`${album} 专辑封面`} lazy={false} />;
  const busy = playbackBusy(props.phase ?? "ready");
  const busyCopy = busy && props.phase && props.phase !== "ready" ? playbackCopy[props.phase] : null;

  function toggleMute() {
    if (volume > 0) lastVolume.current = volume;
    props.onVolumeChange(volume > 0 ? 0 : lastVolume.current);
  }

  return <footer className="capsule-player" aria-label="底部播放器">
    <span className="sr-only" role="status" aria-atomic="true">{busyCopy && `${busyCopy.title}，${busyCopy.detail}`}</span>
    {isMobile && <button className="mobile-now-playing" type="button" onClick={props.onOpenPlayer} aria-label={`打开沉浸播放器：${title}，${artist}`}>
      {coverImage}
      <span className="mobile-now-playing-text"><strong>{title}</strong><span>{artist}</span></span>
    </button>}
    <div className="player-controls">
      <button className={`player-mode-button ${shuffle ? "active" : ""}`} type="button" aria-pressed={shuffle} onClick={props.onToggleShuffle} aria-label={shuffle ? "关闭随机播放" : "随机播放"} title={shuffle ? "关闭随机播放" : "随机播放"}><PlayerShuffleIcon /></button>
      <button className="mini-transport-button" type="button" onClick={props.onPrevious} aria-label="上一首" title="上一首"><Rewind /></button>
      <button className="mini-play-button" type="button" disabled={busy} onClick={props.onTogglePlay} aria-label={busyCopy?.title ?? (playing ? "暂停" : "播放")} title={busyCopy?.title ?? (playing ? "暂停" : "播放")}>{busy ? <LoaderCircle className="button-spinner" aria-hidden="true" /> : playing ? <Pause /> : <Play />}</button>
      <button className="mini-transport-button" type="button" onClick={props.onNext} aria-label="下一首" title="下一首"><FastForward /></button>
      <button className={`player-mode-button ${repeat ? "active" : ""}`} type="button" aria-pressed={repeat > 0} onClick={props.onToggleRepeat} aria-label={repeatLabel} title={repeatLabel}>{repeat === 2 ? <PlayerRepeatOneIcon /> : <PlayerRepeatIcon />}</button>
    </div>
    {!isMobile && <div className={`player-center ${seeking ? "progress-active" : ""}`}>
      <button className="player-cover-button" type="button" onClick={props.onOpenPlayer} aria-label="打开沉浸播放器" title="打开沉浸播放器">{coverImage}<span className="cover-hover-hint" aria-hidden="true"><Maximize2 /></span></button>
      <div className="now-playing">
        <PlayerMarquee key={title} className="now-title" segments={[{ text: title }]} />
        <PlayerMarquee key={`${artist}-${album}`} className="now-links" segments={[
          { text: artist, onClick: props.onOpenArtist },
          { text: " — " },
          { text: album, onClick: props.onOpenAlbum }
        ]} />
      </div>
      <span className="mini-progress-time current-time" aria-hidden="true">{time(position)}</span>
      <span className="mini-progress-time remaining-time" aria-hidden="true">−{time(Math.max(0, duration - position))}</span>
      <input className="mini-progress" type="range" disabled={busy || props.phase !== "ready"} min="0" max={duration} value={seekInput.value} aria-label="播放进度" aria-valuetext={`${time(position)}，共 ${time(duration)}`} style={{ "--progress": `${duration ? seekInput.value / duration * 100 : 0}%` } as CSSProperties}
        {...seekInput.inputProps} />
    </div>}
    <div className="player-actions">
      <button className={`player-utility-button ${props.queueOpen ? "active" : ""}`} type="button" aria-expanded={props.queueOpen} onClick={props.onOpenQueue} aria-label="打开待播清单" title="待播清单"><ListMusic /></button>
      <div className={`volume-control ${volumeExpanded || volumeDragging ? "expanded" : ""}`}
        onMouseEnter={() => setVolumeExpanded(true)} onMouseLeave={() => { if (!volumeDragging) setVolumeExpanded(false); }}
        onFocus={() => setVolumeExpanded(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setVolumeExpanded(false); }}>
        <button className="player-utility-button" type="button" onClick={toggleMute} aria-label={volume ? "静音" : "恢复音量"} title={volume ? "静音" : "恢复音量"}><PlayerVolumeIcon level={volume > 65 ? 3 : volume > 30 ? 2 : 1} muted={volume === 0} /></button>
        <input type="range" min="0" max="100" value={volume} aria-label="音量" aria-valuetext={`${volume}%`} style={{ "--volume": `${volume}%` } as CSSProperties}
          onPointerDown={(event) => { setVolumeExpanded(true); setVolumeDragging(true); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerUp={(event) => { setVolumeDragging(false); if (!event.currentTarget.parentElement?.matches(":hover")) setVolumeExpanded(false); }}
          onPointerCancel={() => { setVolumeDragging(false); setVolumeExpanded(false); }} onLostPointerCapture={() => setVolumeDragging(false)}
          onChange={(event) => props.onVolumeChange(Number(event.currentTarget.value))} />
      </div>
    </div>
  </footer>;
}
