import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { LocateFixed } from "lucide-react";
import "./demo-lyrics.css";

import { activeLyricIndex, wordProgress, type LyricLine } from "./lyrics.js";
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function SyncedLyrics({ trackId, position, readPosition, playing, onSeek, lines }: {
  trackId: string;
  position: number;
  readPosition: () => number;
  playing: boolean;
  onSeek: (position: number) => void;
  lines: LyricLine[];
}) {
  const [following, setFollowing] = useState(true);
  const [viewportHeight, setViewportHeight] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const previousLayout = useRef({ trackId: "", height: 0 });
  const synced = lines.some((line) => line.time !== null);
  const wordSynced = lines.some((line) => line.words?.length);
  const [mediaPosition, setMediaPosition] = useState(position);
  useLayoutEffect(() => { setMediaPosition(readPosition()); }, [trackId, position, playing, readPosition]);
  useEffect(() => {
    if (!playing || !wordSynced) return;
    let frame: number;
    let previousFrame = 0;
    const update = (now: number) => {
      if (now - previousFrame >= 1000 / 30) { setMediaPosition(readPosition()); previousFrame = now; }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [playing, wordSynced, trackId, readPosition]);
  const lyricPosition = playing && wordSynced ? mediaPosition : readPosition();
  const activeIndex = activeLyricIndex(lines, lyricPosition);

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
    if (!synced || !scroller || !line || !viewportHeight || !following) return;
    const layoutChanged = previousLayout.current.trackId !== trackId || previousLayout.current.height !== viewportHeight;
    previousLayout.current = { trackId, height: viewportHeight };
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const top = scroller.scrollTop + line.getBoundingClientRect().top - scroller.getBoundingClientRect().top - viewportHeight * .4 + line.offsetHeight / 2;
    scroller.scrollTo({ top, behavior: layoutChanged || reducedMotion ? "auto" : "smooth" });
  }, [activeIndex, following, trackId, viewportHeight]);

  return <div className={`np-synced-lyrics ${following ? "is-following" : "is-browsing"} ${playing ? "is-playing" : ""}`}>
    <div className="np-lyrics-toolbar"><small>{wordSynced ? "逐词歌词" : synced ? "逐行歌词" : "歌词"}</small></div>
    <div className="np-lyrics-scroll" ref={scrollRef} tabIndex={0} aria-label="可滚动歌词，点击任一句跳转播放进度" onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)} onFocusCapture={(event) => {
      if (event.target instanceof HTMLButtonElement && event.target !== lineRefs.current[activeIndex]) setFollowing(false);
    }} onKeyDown={(event) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) setFollowing(false);
    }}>
      <div className="np-lyrics-lines" style={{ paddingBlock: viewportHeight / 2 }}>
        {lines.map((line, index) => {
          const distance = Math.abs(index - activeIndex);
          return <button key={index} type="button" ref={(element) => { lineRefs.current[index] = element; }} className={`np-lyric-line ${index === activeIndex ? "is-current" : ""}`} style={{ "--lyric-blur": `${Math.min(2.2, Math.max(0, distance - 1) * 1.1)}px` } as CSSProperties} aria-current={index === activeIndex ? "true" : undefined} aria-label={line.time === null ? line.text : `跳转到 ${time(line.time)}，${line.text}`} disabled={line.time === null} onClick={() => { if (line.time !== null) onSeek(line.time); setFollowing(true); }}><span className="np-lyric-text" aria-hidden="true">{line.words?.length && index === activeIndex ? line.words.map((word, wordIndex) => <span key={wordIndex} className="np-lyric-word" style={{ "--word-fill": `${wordProgress(word, lyricPosition) * 100}%` } as CSSProperties}>{word.text}</span>) : line.text}</span></button>;
        })}
      </div>
    </div>
    <div className="np-lyrics-follow">{following ? <span><i aria-hidden="true"><b /><b /><b /></i>{playing ? "歌词随播放滚动" : "点击播放，查看歌词动效"}</span> : <button type="button" onClick={() => { lineRefs.current[activeIndex]?.focus({ preventScroll: true }); setFollowing(true); }}><LocateFixed />回到当前歌词</button>}</div>
  </div>;
}
