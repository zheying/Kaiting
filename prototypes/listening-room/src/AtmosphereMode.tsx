import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronDown, Heart, ListMusic, LoaderCircle, Maximize, MessageSquareText, Minimize, Music2, Pause, Play, SkipBack, SkipForward, SlidersHorizontal, Sparkles, Grid2X2, Volume2, VolumeX, X } from "lucide-react";
import { useSeekInput } from "../../../src/client/seek-input";
import type { AtmosphereAudio } from "./atmosphere-audio";
import { createAtmosphereScene, type AtmospherePalette, type AtmosphereTheme } from "./atmosphere-scene";
import { PlaybackFeedback } from "./StateComponents";
import { playbackBusy, type PlaybackPhase } from "./prototype-state";
import { lightingLooks, cueAt, type LightingProgram, type LightingLook, type RealMusicTrack } from "./lighting-program";
import "./atmosphere.css";

const colors = [{ id: "aurora", label: "琥珀" }, { id: "ember", label: "暗红" }, { id: "silver", label: "深蓝" }] as const;
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const pickerLooks = [...lightingLooks].sort((a, b) => Number("new" in b) - Number("new" in a));

function LightingSketch({ look, index }: { look: LightingLook; index: number }) {
  let paths: string[];
  switch (look) {
    case "duet": paths = ["M36 7 L18 51 M36 7 L49 51 M84 7 L71 51 M84 7 L102 51", "M18 51 Q34 58 49 51 M71 51 Q87 58 102 51"]; break;
    case "rain": paths = Array.from({ length: 8 }, (_, i) => `M${27 + i * 12} 7 l-22 46`); break;
    case "horizon": paths = Array.from({ length: 5 }, (_, i) => `M8 ${16 + i * 7} L112 ${17 + i * 7}`); break;
    case "lattice": paths = Array.from({ length: 7 }, (_, i) => `M${12 + i * 16} 7 L${108 - i * 16} 53`); break;
    case "searchlights": paths = Array.from({ length: 8 }, (_, i) => `M${25 + i * 10} 53 l${i < 4 ? -23 : 23} -46`); break;
    case "afterglow": paths = []; break;
    default: paths = Array.from({ length: look === "spotlight" ? 1 : 8 }, (_, n) => {
      const x = 18 + n * 12, low = index % 3 === 0;
      const target = look === "curtain" ? x : look === "particles" || look === "burst" ? -15 + n * 22 : look === "geometry" || look === "wings" ? 115 - n * 16 : 60 + Math.sin(n + index) * 40;
      return `M${look === "spotlight" ? 60 : x} ${low ? 52 : 7} L${look === "spotlight" ? 60 : target} ${low ? 6 : 52}`;
    });
  }
  return <svg className={`av-look-sketch av-sketch-${look}`} viewBox="0 0 120 60" aria-hidden="true">
    {paths.map((d, n) => <path key={n} d={d} opacity={.4 + n % 3 * .2} />)}
    {look === "afterglow" && [0, 1, 2, 3].map((n) => <ellipse key={n} cx={45 + n * 10} cy={32} rx={39 - n * 5} ry={22 - n * 3} fill="currentColor" stroke="none" opacity=".12" />)}
  </svg>;
}

type Props = {
  audio: AtmosphereAudio | null; audioError: string;
  sourceBusy: boolean; realAudio: boolean; program: LightingProgram | null; analysisError?: string;
  availableTracks: RealMusicTrack[]; onSelectTrack: (id: string) => void; onRetryAudio: () => void;
  theme: AtmosphereTheme; onTheme: (theme: AtmosphereTheme) => void;
  palette: AtmospherePalette; onPalette: (palette: AtmospherePalette) => void;
  vivid: boolean; onVivid: (vivid: boolean) => void;
  title: string; artist: string; trackId: string; duration: number;
  position: number; playing: boolean; volume: number; favorite: boolean;
  phase: PlaybackPhase; panel: "lyrics" | "queue" | null;
  onClose: () => void; onClosePanel: () => void;
  onTogglePanel: (panel: "lyrics" | "queue") => void;
  onTogglePlay: () => void; onPrevious: () => void; onNext: () => void;
  onSeek: (position: number) => void; onVolume: (volume: number) => void;
  onFavorite: () => void; onRetry: () => void; children: ReactNode;
};

export function AtmosphereMode(props: Props) {
  const { audio, playing, phase, panel, audioError, theme } = props;
  const seekInput = useSeekInput({ position: props.position, duration: props.duration, trackId: props.trackId, onSeek: seek });
  const root = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const flowCanvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<ReturnType<typeof createAtmosphereScene> | null>(null);
  const { palette, vivid } = props;
  const [settings, setSettings] = useState(false);
  const [picker, setPicker] = useState<"looks" | "music" | null>(null);
  const [query, setQuery] = useState("");
  const [liveLook, setLiveLook] = useState<LightingLook>("spotlight");
  const [hidden, setHidden] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [sceneError, setSceneError] = useState("");
  const [fullscreenError, setFullscreenError] = useState("");
  const idleTimer = useRef<number | null>(null);
  const lastVolume = useRef(props.volume || 70);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const busy = playbackBusy(phase) || props.sourceBusy;
  const playbackRequested = playing && phase === "ready" && !props.sourceBusy;
  const active = playbackRequested && !audioError;
  const cue = cueAt(props.program, props.position);
  const scheduledTheme = theme === "auto" ? cue?.look ?? "auto" : theme;
  const selectedLook = scheduledTheme === "auto" ? liveLook : scheduledTheme;
  const currentTheme = lightingLooks.find((item) => item.id === selectedLook)!;
  const matchingTracks = props.availableTracks.filter((item) => `${item.title} ${item.artist} ${item.album}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const canHide = useRef(false);
  canHide.current = active && !panel && !settings && !picker && !sceneError && !fullscreenError;

  function wake() {
    setHidden(false);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    if (canHide.current) idleTimer.current = window.setTimeout(() => setHidden(true), 4500);
  }
  useEffect(() => { wake(); }, [active, panel, settings, picker, sceneError, fullscreenError]);
  useEffect(() => {
    root.current?.focus();
    return () => { if (idleTimer.current) window.clearTimeout(idleTimer.current); };
  }, []);
  useEffect(() => { audio?.sync(playbackRequested, props.position, props.volume, props.trackId); }, [audio, playbackRequested, props.position, props.volume, props.trackId]);
  useEffect(() => {
    if (!canvas.current || !flowCanvas.current) return;
    try {
      scene.current = createAtmosphereScene(canvas.current, flowCanvas.current, () => audio?.read() ?? {
        bass: 0, middle: 0, treble: 0, energy: 0, pulse: 0, lowPulse: 0, epoch: 0, position: 0, spectrum: new Float32Array(96), waveform: new Float32Array(128)
      }, setFallback, setLiveLook);
    } catch (error) { setSceneError(error instanceof Error ? error.message : "画面暂时无法显示。"); }
    return () => { scene.current?.dispose(); scene.current = null; };
  }, [audio]);
  useEffect(() => { scene.current?.update({ theme: scheduledTheme, palette, vivid, playing: active }); }, [scheduledTheme, palette, vivid, active]);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      if (document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  function togglePlay() {
    if (!playing) void audio?.unlock();
    props.onTogglePlay(); wake();
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen();
      else await root.current?.requestFullscreen();
      setFullscreenError("");
    } catch { setFullscreenError("此浏览器暂时无法进入全屏，可以继续在当前页面观看。"); }
  }
  function seek(value: number) { audio?.seek(value); props.onSeek(value); }
  function mute() {
    if (props.volume > 0) lastVolume.current = props.volume;
    props.onVolume(props.volume > 0 ? 0 : lastVolume.current);
  }
  function closeSettings() { setSettings(false); settingsButton.current?.focus(); }

  return <section ref={root} tabIndex={-1} aria-label="氛围模式" className={`atmosphere-mode palette-${palette} ${hidden ? "av-hide-controls" : ""} ${panel ? "av-with-panel" : ""}`} data-theme={theme} data-lighting-look={selectedLook} data-source={props.realAudio ? "library" : "demo"} data-motion={active ? "playing" : "paused"} onPointerMove={wake} onPointerDown={wake} onFocusCapture={wake} onKeyDownCapture={(event) => {
    wake();
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (picker) { setPicker(null); root.current?.focus(); } else if (settings) closeSettings(); else if (panel) props.onClosePanel(); else props.onClose();
    }
    if (event.code === "Space" && event.target === root.current) { event.preventDefault(); event.stopPropagation(); togglePlay(); }
  }}>
    <div className="av-visual" aria-hidden="true"><canvas ref={canvas} /><canvas ref={flowCanvas} hidden /></div>
    <div className="av-shade" aria-hidden="true" />
    <header className="av-header av-hud">
      <button className="av-back" onClick={props.onClose} aria-label="返回播放页"><ArrowLeft size={18} /><span>返回播放页</span></button>
      <span className="av-wordmark">开听<span>氛围模式</span></span>
      <div className="av-header-actions">
        {document.fullscreenEnabled && <button className="av-icon" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "退出全屏" : "进入全屏"} title={fullscreen ? "退出全屏" : "进入全屏"}>{fullscreen ? <Minimize /> : <Maximize />}</button>}
        <button ref={settingsButton} className={`av-icon ${settings ? "av-selected" : ""}`} aria-label="画面设置" aria-expanded={settings} aria-controls={settings ? "av-settings" : undefined} onClick={() => setSettings((value) => !value)}><SlidersHorizontal /></button>
      </div>
    </header>
    <div className="av-theme-nav av-hud" role="group" aria-label="视觉主题">
      <button aria-pressed={theme === "auto"} onClick={() => { props.onTheme("auto"); setPicker(null); }}><Sparkles size={16} /><span>跟随音乐</span></button>
      <button aria-label="灯光编排" aria-expanded={picker === "looks"} aria-pressed={theme !== "auto"} onClick={() => { setPicker(picker === "looks" ? null : "looks"); setSettings(false); }}><Grid2X2 size={16} /><span>灯光编排</span><ChevronDown size={13} /></button>
      {props.realAudio && <button aria-label="选择真实曲目" aria-expanded={picker === "music"} onClick={() => { setPicker(picker === "music" ? null : "music"); setSettings(false); }}><Music2 size={16} /><span>选曲</span></button>}
    </div>
    <div className="av-theme-caption av-hud"><span>{busy ? "正在准备真实音频与灯光" : theme === "auto" ? `${currentTheme.name} · ${cue?.reason ?? "实时跟随声音"}` : currentTheme.name}</span><p>{busy ? "初次播放会稍等片刻" : currentTheme.description}</p></div>

    {picker && <aside className={`av-picker av-${picker}-picker`} aria-label={picker === "looks" ? "灯光编排面板" : "真实曲目面板"}>
      <div className="av-settings-heading"><div><strong>{picker === "looks" ? "给这一刻，换一场灯光" : "从曲库走进现场"}</strong><p>{picker === "looks" ? `${lightingLooks.length} 种灯光 · 明暗与运动仍跟随声音` : `${props.availableTracks.length.toLocaleString()} 首真实录音 · 选择后开始播放`}</p></div><button className="av-icon" aria-label="关闭选择面板" onClick={() => { setPicker(null); root.current?.focus(); }}><X /></button></div>
      {picker === "looks" ? <div className="av-look-grid">{pickerLooks.map((item, index) => <button key={item.id} aria-label={item.name} aria-pressed={theme === item.id} onClick={() => { props.onTheme(item.id); setPicker(null); root.current?.focus(); }}>
        <LightingSketch look={item.id} index={index} /><span>{item.name}{"new" in item && <em className="av-look-new">新增</em>}</span><small>{item.description}</small>{theme === item.id && <Check className="av-look-check" size={14} />}
      </button>)}</div> : <><input className="av-track-search" autoFocus placeholder="搜索歌曲、艺人、专辑" aria-label="搜索真实曲目" value={query} onChange={(event) => setQuery(event.currentTarget.value)} /><div className="av-track-list">{matchingTracks.slice(0, 60).map((item) => <button key={item.id} aria-label={`播放真实曲目 ${item.title}`} aria-current={item.id === props.trackId ? "true" : undefined} onClick={() => { props.onSelectTrack(item.id); setPicker(null); root.current?.focus(); }}><Music2 size={16} /><span><strong>{item.title}</strong><small>{item.artist} · {item.album}</small></span><small>{time(item.duration)}</small></button>)}{!matchingTracks.length && <p>没有找到匹配的曲目</p>}{matchingTracks.length > 60 && <p>已显示前 60 首，可输入曲名继续查找</p>}</div></>}
    </aside>}

    {settings && <aside className="av-settings" id="av-settings" aria-label="画面设置面板">
      <div className="av-settings-heading"><strong>画面设置</strong><button className="av-icon" onClick={closeSettings} aria-label="关闭画面设置"><X /></button></div>
      <span className="av-setting-label">动效强度</span><div className="av-choice" role="group" aria-label="动效强度"><button aria-pressed={!vivid} onClick={() => props.onVivid(false)}>轻柔</button><button aria-pressed={vivid} onClick={() => props.onVivid(true)}>鲜明</button></div>
      <span className="av-setting-label">色调</span><div className="av-color-choice" role="group" aria-label="色调">{colors.map((item) => <button className={`av-swatch-${item.id}`} aria-pressed={palette === item.id} key={item.id} onClick={() => props.onPalette(item.id)}><i aria-hidden="true">{palette === item.id && <Check size={12} />}</i>{item.label}</button>)}</div>
      <p>声音的起伏，决定画面的变化。</p>
    </aside>}

    {panel && <aside className="av-companion" aria-label={panel === "lyrics" ? "氛围歌词面板" : "氛围待播面板"}><button className="av-panel-close av-icon" onClick={props.onClosePanel} aria-label={panel === "lyrics" ? "收起歌词" : "收起待播清单"}><X /></button>{props.children}</aside>}

    <footer className="av-footer av-hud">
      <div className="av-now"><span className="av-sound-label">{props.realAudio ? "曲库原曲" : "原创演示音源"}<span>{props.realAudio ? theme === "auto" ? props.program ? "本曲灯光编排" : "实时灯光" : "手动灯光" : "非本曲音频"}</span></span><h1 title={props.title}>{props.title}</h1><p>{props.artist}</p></div>
      <div className="av-seek"><input type="range" min={0} max={props.duration} value={seekInput.value} disabled={phase !== "ready" || props.sourceBusy} aria-label="氛围播放进度" aria-valuetext={`${time(props.position)}，共 ${time(props.duration)}`} style={{ "--av-progress": `${seekInput.value / Math.max(1, props.duration) * 100}%` } as CSSProperties} {...seekInput.inputProps} /><div><span>{time(props.position)}</span><span>{time(props.duration)}</span></div></div>
      <div className="av-controls">
        <div className="av-secondary"><button className={`av-icon ${panel === "lyrics" ? "av-selected" : ""}`} aria-label="氛围歌词" aria-pressed={panel === "lyrics"} onClick={() => props.onTogglePanel("lyrics")}><MessageSquareText /></button><button className={`av-icon ${props.favorite ? "av-selected" : ""}`} aria-label={props.favorite ? "氛围取消收藏" : "氛围收藏"} aria-pressed={props.favorite} onClick={props.onFavorite}><Heart fill={props.favorite ? "currentColor" : "none"} /></button></div>
        <div className="av-transport"><button className="av-icon" aria-label="氛围上一首" onClick={props.onPrevious}><SkipBack fill="currentColor" /></button><button className="av-play" aria-label={busy ? "氛围正在准备音频" : playing ? "氛围暂停" : "氛围播放"} onClick={togglePlay} disabled={busy}>{busy ? <LoaderCircle className="button-spinner" /> : playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button><button className="av-icon" aria-label="氛围下一首" onClick={props.onNext}><SkipForward fill="currentColor" /></button></div>
        <div className="av-secondary av-right"><button className={`av-icon ${panel === "queue" ? "av-selected" : ""}`} aria-label="氛围待播清单" aria-pressed={panel === "queue"} onClick={() => props.onTogglePanel("queue")}><ListMusic /></button><div className="av-volume"><button className="av-icon" aria-label={props.volume ? "氛围静音" : "氛围恢复音量"} onClick={mute}>{props.volume ? <Volume2 /> : <VolumeX />}</button><input aria-label="氛围音量" aria-valuetext={`${props.volume}%`} type="range" min={0} max={100} value={props.volume} onChange={(event) => props.onVolume(Number(event.currentTarget.value))} /></div></div>
      </div>
      {(audioError || sceneError || fullscreenError) && <div className="av-notice" role="alert"><span>{audioError || sceneError || fullscreenError}</span>{audioError && audio && <button onClick={props.onRetryAudio}>重试音频</button>}</div>}
      {props.analysisError && <p className="av-fallback" role="status">{props.analysisError}</p>}
      {phase !== "ready" && phase !== "transcoding" && <PlaybackFeedback phase={phase} onRetry={props.onRetry} onNext={props.onNext} />}
      {fallback && <p className="av-fallback" role="status">此设备使用简化画面</p>}
    </footer>
    <span className="av-wake-hint" aria-hidden="true"><ChevronDown size={14} />轻触画面，唤回控制</span>
  </section>;
}
