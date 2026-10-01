import { useMemo } from "react";
import { SyncedLyrics } from "../../../src/client/room/SyncedLyrics";
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

export function DemoLyrics({ trackId, duration, position, readPosition, playing, onSeek, onShowEmpty }: {
  trackId: string;
  duration: number;
  position: number;
  readPosition: () => number;
  playing: boolean;
  onSeek: (position: number) => void;
  onShowEmpty: () => void;
}) {
  // 演示数据只有行时间；逐词进度和跟随规则直接复用正式版，不推算不存在的字时间。
  const lines = useMemo(() => SAMPLE_LINES.map(([fraction, text]) => ({ time: Math.floor(Math.max(0, duration) * fraction), text })), [duration]);
  return <div className="np-demo-lyrics">
    <div className="np-lyrics-toolbar"><small>原创演示 · 非本曲歌词</small><button type="button" onClick={onShowEmpty} title="查看没有歌词时的显示方式">无歌词</button></div>
    <SyncedLyrics trackId={trackId} position={position} readPosition={readPosition} playing={playing} onSeek={onSeek} lines={lines} />
  </div>;
}
