import type { ScanJob } from "../shared/types.js";

/** Both abort the transport and guard callbacks from work that cannot be aborted. */
export function createLatestRequest() {
  let active: AbortController | undefined;
  return {
    begin() {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      return {
        signal: controller.signal,
        isCurrent: () => active === controller && !controller.signal.aborted
      };
    },
    cancel() {
      active?.abort();
      active = undefined;
    }
  };
}

export function scanJustFinished(previous: ScanJob | null | undefined, next: ScanJob | null): boolean {
  // The first snapshot is already included in the initial library load.
  return previous !== undefined && (next?.status === "completed" || next?.status === "failed")
    && (previous?.id !== next.id || previous.status !== next.status);
}

export type PlaybackStatus =
  | { state: "idle" | "paused" | "playing" }
  | { state: "loading" | "buffering" | "error"; message: string };

export function playbackErrorMessage(error: unknown, mediaErrorCode?: number): string {
  if (error instanceof Error && error.name === "NotAllowedError") return "浏览器阻止了自动播放，请点击重试开始播放。";
  if (mediaErrorCode === 2) return "音频加载中断，请检查 NAS 连接后重试。";
  if (mediaErrorCode === 3) return "音频解码失败，请重试或切换歌曲。";
  if (mediaErrorCode === 4) return "音频暂时无法播放，请确认文件可用及转码服务正常后重试。";
  return "播放失败，请检查网络及 NAS 服务后重试。";
}
