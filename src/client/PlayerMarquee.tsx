import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";

interface MarqueeSegment {
  text: string;
  onClick?: () => void;
}

/** A single, measured pass keeps long player metadata readable without a perpetual ticker. */
export function PlayerMarquee({ segments, className = "" }: {
  segments: MarqueeSegment[];
  className?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [distance, setDistance] = useState(0);
  const [running, setRunning] = useState(false);
  const reducedMotion = useRef(false);
  const text = segments.map((segment) => segment.text).join("");

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let previousWidth = -1;
    let previousContentWidth = -1;
    const measure = () => {
      const width = viewport.getBoundingClientRect().width;
      const contentWidth = content.getBoundingClientRect().width;
      const changed = width !== previousWidth || contentWidth !== previousContentWidth;
      previousWidth = width;
      previousContentWidth = contentWidth;
      reducedMotion.current = media.matches;
      const nextDistance = width > 0 && contentWidth > width + 1 ? contentWidth + 28 : 0;
      setDistance(nextDistance);
      if (media.matches || !nextDistance) setRunning(false);
      else if (changed && !viewport.contains(document.activeElement)) setRunning(true);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    media.addEventListener("change", measure);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", measure);
    };
  }, [text]);

  const style = {
    "--marquee-distance": `${distance}px`,
    "--marquee-duration": `${distance / 20}s`
  } as CSSProperties;

  return <div
    ref={viewportRef}
    className={`player-marquee ${className} ${distance ? "is-overflowing" : ""} ${running ? "is-running" : ""}`}
    style={style}
    title={text}
    onPointerEnter={(event) => {
      if (event.pointerType === "mouse" && distance && !reducedMotion.current
        && !event.currentTarget.contains(document.activeElement)) setRunning(true);
    }}
    onFocusCapture={(event) => {
      setRunning(false);
      const viewport = event.currentTarget;
      const target = event.target;
      // Position the focused link after the scrolling transform has been removed.
      requestAnimationFrame(() => {
        const content = contentRef.current;
        if (!content || document.activeElement !== target) return;
        const targetRect = target.getBoundingClientRect();
        const offset = targetRect.left - content.getBoundingClientRect().left;
        viewport.scrollLeft = Math.max(0, Math.min(offset, offset + targetRect.width - viewport.clientWidth));
      });
    }}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.scrollLeft = 0;
    }}
  >
    <div className="player-marquee-track" onAnimationEnd={() => setRunning(false)}>
      <div className="player-marquee-content" ref={contentRef}>
        {segments.map((segment, index) => segment.onClick
          ? <button key={index} type="button" onClick={segment.onClick}>{segment.text}</button>
          : <span key={index}>{segment.text}</span>)}
      </div>
      {distance > 0 && <div className="player-marquee-content player-marquee-copy" aria-hidden="true">
        {/* The visual copy retains pointer actions, but adds no tab stops or spoken duplicates. */}
        {segments.map((segment, index) => <span
          key={index}
          className={segment.onClick ? "player-marquee-link" : undefined}
          onClick={segment.onClick}
        >{segment.text}</span>)}
      </div>}
    </div>
  </div>;
}
