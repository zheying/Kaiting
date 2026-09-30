export function moveItem<T>(items: T[], index: number, offset: number): T[] {
  const destination = index + offset;
  if (!Number.isInteger(index) || !Number.isInteger(destination) || index < 0 || index >= items.length || destination < 0 || destination >= items.length || index === destination) return items;
  const result = [...items];
  const [item] = result.splice(index, 1);
  result.splice(destination, 0, item);
  return result;
}
export const readable = (value: string | null | undefined, fallback: string) => value?.trim() || fallback;
export const yearLabel = (year: number | null | undefined) => year && year > 0 ? String(year) : "年份未知";
export const trackTime = (seconds: number | null | undefined) => seconds && Number.isFinite(seconds) && seconds > 0 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "—";
export type PlaybackPhase = "ready" | "loading" | "buffering" | "transcoding" | "offline" | "missing" | "decode" | "blocked";
export const playbackCopy: Record<Exclude<PlaybackPhase, "ready">, { title: string; detail: string; action?: string }> = {
  loading: { title: "正在准备播放", detail: "正在读取音乐文件，请稍候。" },
  buffering: { title: "正在缓冲", detail: "连接有些慢，缓冲完成后会继续播放。" },
  transcoding: { title: "正在转换音频", detail: "为浏览器准备可播放的格式，原文件不会改变。" },
  offline: { title: "与音乐室的连接中断了", detail: "检查网络或 NAS 连接后重试。", action: "重新连接" },
  missing: { title: "找不到这首歌的文件", detail: "文件可能已移动，或音乐目录暂时不可用。", action: "检查目录" },
  decode: { title: "这首歌暂时无法播放", detail: "音频读取失败，可以重试或先听下一首。", action: "重新播放" },
  blocked: { title: "音乐已准备好", detail: "浏览器需要你点击一次，才会开始播放。", action: "点击播放" }
};
export const playbackBusy = (phase: PlaybackPhase) => ["loading", "buffering", "transcoding"].includes(phase);


import type { ScanJob } from "../../shared/types.js";
import { scanJustFinished } from "../async-state.js";
export type ScanState = { status: "idle" | "running" | "complete" | "partial" | "empty" | "interrupted" | "failed"; path: string; processed: number; total: number; reason?: "connection" | "stopped"; message?: string };
export function scanState(job: ScanJob | null, path: string, trackCount: number): ScanState {
  const status = !job ? "idle" : job.status === "running" ? "running" : job.status === "interrupted" ? "interrupted" : job.status === "completed" ? job.errorCount ? "partial" : trackCount ? "complete" : "empty" : job.totalFiles === 0 && !trackCount && job.message?.includes("未找到音频") ? "empty" : "failed";
  return { status, path, processed: job?.scannedFiles ?? 0, total: job?.totalFiles ?? 0, reason: job?.status === "interrupted" ? "stopped" : "connection", message: job?.message ?? undefined };
}

export function scanCompletionNotice(previous: ScanJob | null | undefined, next: ScanJob | null, trackCount: number): string {
  if (!scanJustFinished(previous, next)) return "";
  const { status } = scanState(next, "", trackCount);
  if (status === "complete") return "扫描完成，音乐已经准备好";
  if (status === "partial") return "扫描部分完成，可以查看失败详情";
  if (status === "empty") return "扫描完成，未发现可播放文件";
  return "";
}
