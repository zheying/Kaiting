import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { LocateFixed } from "lucide-react";
import "./demo-lyrics.css";

// 原型专用的原创示例文字，不是当前录音的实际歌词。
const SAMPLE_LINES = [
  [0, "把窗留给晚风"],
  [.04, "把脚步交给街灯"],
  [.08, "一天的喧嚣渐渐远去"],
  [.14, "让时间再慢一点"],
  [.2, "让这一刻多停一会儿"],
  [.26, "熟悉的旋律轻轻响起"],
  [.33, "像有人在耳边说晚安"],
  [.4, "我们走过长长的街"],
  [.48, "也曾追着远方的光"],
  [.56, "那些没说完的话"],
  [.64, "都藏在下一段旋律里"],
  [.72, "不必急着寻找答案"],
  [.79, "此刻就靠近一点"],
  [.85, "等晚风吹过这扇窗"],
  [.9, "等最后一个音符落下"],
  [.95, "把今天轻轻收藏"]
] as const;

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function DemoLyrics({ trackId, duration, position, playing, onSeek, onShowEmpty }: {
  trackId: string;
  duration: number;
  position: number;
  playing: boolean;
  onSeek: (position: number) => void;
  onShowEmpty: () => void;
}) {
  const [following, setFollowing] = useState(true);
  const [viewportHeight, setViewportHeight] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const previousLayout = useRef({ trackId: "", height: 0 });
  const lines = SAMPLE_LINES.map(([fraction, text]) => ({ time: Math.floor(Math.max(0, duration) * fraction), text }));
  const activeIndex = lines.reduce((current, line, index) => position >= line.time ? index : current, 0);
  const activeLineDuration = Math.max(1, (lines[activeIndex + 1]?.time ?? duration) - lines[activeIndex].time);
  const lineProgress = Math.min(1, Math.max(0, (position - lines[activeIndex].time) / activeLineDuration));

  useEffect(() => { setFollowing(true); }, [trackId]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const resize = () => setViewportHeight(scroller.clientHeight);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const line = lineRefs.current[activeIndex];
    if (!scroller || !line || !viewportHeight || !following) return;
    const layoutChanged = previousLayout.current.trackId !== trackId || previousLayout.current.height !== viewportHeight;
    previousLayout.current = { trackId, height: viewportHeight };
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const top = scroller.scrollTop + line.getBoundingClientRect().top - scroller.getBoundingClientRect().top - viewportHeight * .4 + line.offsetHeight / 2;
    scroller.scrollTo({ top, behavior: layoutChanged || reducedMotion ? "auto" : "smooth" });
  }, [activeIndex, following, trackId, viewportHeight]);

  return <div className={`np-synced-lyrics ${following ? "is-following" : "is-browsing"} ${playing ? "is-playing" : ""}`}>
    <div className="np-lyrics-toolbar"><small>原创演示 · 非本曲歌词</small><button type="button" onClick={onShowEmpty} title="查看没有歌词时的显示方式">无歌词</button></div>
    <div className="np-lyrics-scroll" ref={scrollRef} tabIndex={0} aria-label="可滚动歌词，点击任一句跳转播放进度" onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)} onFocusCapture={(event) => {
      if (event.target instanceof HTMLButtonElement && event.target !== lineRefs.current[activeIndex]) setFollowing(false);
    }} onKeyDown={(event) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) setFollowing(false);
    }}>
      <div className="np-lyrics-lines" style={{ paddingBlock: viewportHeight / 2 }}>
        {lines.map((line, index) => {
          const distance = Math.abs(index - activeIndex);
          const characters = Array.from(line.text);
          return <button key={index} type="button" ref={(element) => { lineRefs.current[index] = element; }} className={`np-lyric-line ${index === activeIndex ? "is-current" : ""}`} style={{ "--lyric-blur": `${Math.min(2.2, Math.max(0, distance - 1) * 1.1)}px` } as CSSProperties} aria-current={index === activeIndex ? "true" : undefined} aria-label={`跳转到 ${time(line.time)}，${line.text}`} onClick={() => { onSeek(line.time); setFollowing(true); }}><span className="np-lyric-text" aria-hidden="true">{index === activeIndex ? characters.map((character, characterIndex) => <span key={characterIndex} className="np-lyric-word" style={{ "--word-fill": `${Math.max(0, Math.min(1, lineProgress * characters.length - characterIndex)) * 100}%` } as CSSProperties}>{character}</span>) : line.text}</span></button>;
        })}
      </div>
    </div>
    <div className="np-lyrics-follow">{following ? <span><i aria-hidden="true"><b /><b /><b /></i>{playing ? "歌词随播放滚动" : "点击播放，查看歌词动效"}</span> : <button type="button" onClick={() => { lineRefs.current[activeIndex]?.focus({ preventScroll: true }); setFollowing(true); }}><LocateFixed />回到当前歌词</button>}</div>
  </div>;
}
