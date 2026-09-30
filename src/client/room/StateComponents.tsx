import { useLayoutEffect, useRef, useState } from "react";
import { CircleAlert, Disc3, FileQuestion, FolderOpen, LoaderCircle, Play, RefreshCw, WifiOff } from "lucide-react";
import { playbackBusy, playbackCopy, type PlaybackPhase } from "./room-state.js";
import { isLibraryArtwork, sizedArtworkUrl } from "../artwork.js";
import { artworkSizeFor, type ArtworkSize } from "../../shared/artwork.js";

const mobilePlaybackCopy: Partial<Record<PlaybackPhase, { title: string; detail: string }>> = {
  offline: { title: "连接中断", detail: "检查网络或 NAS 后重试" },
  missing: { title: "找不到音乐文件", detail: "检查文件位置或音乐目录" },
  decode: { title: "暂时无法播放", detail: "重试，或用播放器切换下一首" },
  blocked: { title: "音乐已准备好", detail: "点击播放，开始聆听" }
};

export function Artwork({ src, alt, className = "cover", lazy = true }: { src?: string; alt: string; className?: string; lazy?: boolean }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<ArtworkSize>();
  const [failedSource, setFailedSource] = useState<string>();
  useLayoutEffect(() => setFailedSource(undefined), [src]);
  const failed = Boolean(src && failedSource === src);
  const local = isLibraryArtwork(src);
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!image || !local) return;
    const measure = () => {
      const pixels = Math.max(image.clientWidth, image.clientHeight) * (window.devicePixelRatio || 1);
      if (pixels <= 0) return;
      const target = artworkSizeFor(pixels);
      // Once loaded, keep a larger version when a panel or resize makes this
      // element smaller; re-downloading a smaller copy would waste bandwidth.
      setSize((previous) => previous && previous >= target ? previous : target);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(image);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [src, local, failed]);
  // Deliberately omit src until layout is known. Starting with the original
  // would let the browser download it before ResizeObserver can replace it.
  const requestSrc = src && local ? size ? sizedArtworkUrl(src, size) : undefined : src;
  return !src || failed
    ? <span className={`${className} artwork-fallback`} role="img" aria-label={`${alt || "专辑封面"}，暂无封面`}><Disc3 aria-hidden="true" /></span>
    : <img ref={imageRef} src={requestSrc} alt={alt} className={className} loading={lazy ? "lazy" : "eager"} decoding="async" draggable={false} onError={() => { if (requestSrc) setFailedSource(src); }} />;
}

export function PlaybackFeedback({ phase, onRetry, onNext, compact = false, isMobile = false }: { phase: PlaybackPhase; onRetry: () => void; onNext: () => void; compact?: boolean; isMobile?: boolean }) {
  if (phase === "ready") return null;
  const copy = playbackCopy[phase];
  const busy = playbackBusy(phase);
  if (compact && busy) return null;
  const mobileCompact = compact && isMobile;
  const displayCopy = mobileCompact ? mobilePlaybackCopy[phase] ?? copy : copy;
  const StatusIcon = busy ? LoaderCircle : phase === "missing" ? FileQuestion : phase === "decode" ? CircleAlert : phase === "blocked" ? Play : WifiOff;
  const ActionIcon = phase === "missing" ? FolderOpen : phase === "blocked" ? Play : RefreshCw;
  return <div className={`playback-feedback ${compact ? "is-compact" : ""}`} role={busy ? "status" : "alert"}>
    {compact ? <span className="feedback-status-icon" aria-hidden="true"><StatusIcon /></span> : <StatusIcon className={busy ? "button-spinner" : undefined} aria-hidden="true" />}
    <div className="feedback-copy"><strong title={compact ? copy.title : undefined}>{displayCopy.title}</strong><p title={compact ? copy.detail : undefined}>{displayCopy.detail}</p></div>
    {!busy && <div className="feedback-actions">
      <button type="button" className={compact ? "button feedback-retry" : undefined} onClick={onRetry}>{compact && <ActionIcon aria-hidden="true" />}{copy.action}</button>
      {phase !== "blocked" && !compact && <button type="button" onClick={onNext}>下一首</button>}
    </div>}
  </div>;
}

export function ContentSkeleton({ detail = false }: { detail?: boolean }) {
  const rowsRef = useRef<HTMLDivElement>(null);
  const [rowCount, setRowCount] = useState(1);
  useLayoutEffect(() => {
    const rows = rowsRef.current;
    if (!rows) return;
    const fillRows = () => {
      const rowHeight = parseFloat(getComputedStyle(rows).getPropertyValue("--skeleton-row-height"));
      setRowCount(Math.max(1, Math.ceil(rows.clientHeight / rowHeight)));
    };
    fillRows();
    const observer = new ResizeObserver(fillRows);
    observer.observe(rows);
    return () => observer.disconnect();
  }, []);
  return <section className={`content-skeleton ${detail ? "is-detail" : ""}`} role="status" aria-label={detail ? "正在载入专辑详情" : "正在载入音乐列表"} aria-busy="true">
    <span className="sr-only">{detail ? "正在载入专辑详情…" : "正在载入音乐列表…"}</span>
    {detail && <div className="skeleton-hero" aria-hidden="true"><span /><div><i /><i /><i /></div></div>}
    <div ref={rowsRef} className="skeleton-rows" aria-hidden="true">
      {Array.from({ length: rowCount }, (_, index) => <div className="skeleton-row" key={index}><span /><i /><b /></div>)}
    </div>
  </section>;
}
