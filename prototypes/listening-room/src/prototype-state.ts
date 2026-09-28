export type ScanOutcome = "complete" | "partial" | "empty";
export type ScanState = {
  status: "idle" | "running" | "complete" | "partial" | "empty" | "interrupted" | "failed";
  path: string;
  processed: number;
  total: number;
  outcome: ScanOutcome;
  reason?: "connection" | "stopped";
};
export const idleScan: ScanState = { status: "idle", path: "/music", processed: 0, total: 1054, outcome: "complete" };
export function beginScan(path: string, outcome: ScanOutcome = "complete"): ScanState {
  return { status: "running", path, processed: 0, total: outcome === "partial" ? 1057 : outcome === "empty" ? 12 : 1054, outcome };
}
export function advanceScan(scan: ScanState): ScanState {
  if (scan.status !== "running") return scan;
  const processed = Math.min(scan.total, scan.processed + Math.ceil(scan.total / 8));
  return { ...scan, processed, status: processed === scan.total ? scan.outcome : "running" };
}
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

export const previewGroups = [
  { name: "开始使用与登录", description: "从第一次连接，到安全地回到音乐室。", items: [
    ["setup-empty", "初次设置"], ["library-empty", "曲库为空"], ["home-new", "尚未聆听"],
    ["login-invalid", "密码错误"], ["login-offline", "登录连接失败"], ["login-expired", "登录已过期"]
  ] },
  { name: "账号与音乐室成员", description: "管理员照顾音乐室，每个人照顾自己的喜欢。", items: [
    ["account", "管理员账号"], ["account-member", "普通账号"], ["account-security", "登录与安全"],
    ["accounts-manage", "用户管理"], ["account-create", "创建账号"], ["login-first-use", "首次设置密码"], ["login-disabled", "账号已停用"],
    ["account-denied", "无管理权限"], ["accounts-loading", "账号列表载入中"], ["accounts-error", "账号列表载入失败"], ["accounts-empty", "账号搜索无结果"], ["account-save-error", "资料保存失败"]
  ] },
  { name: "音乐目录与扫描", description: "进度、结果和每一种恢复路径。", items: [
    ["scan-running", "扫描进行中"], ["scan-complete", "全部扫描成功"], ["scan-partial", "部分扫描成功"],
    ["scan-empty", "未发现音乐"], ["scan-failed", "无法启动扫描"], ["scan-interrupted", "扫描中断"], ["directory-unavailable", "目录不可访问"]
  ] },
  { name: "播放与歌词", description: "底部播放器与沉浸播放器共享同一状态。", items: [
    ["player-empty", "尚未选择歌曲"], ["player-loading", "准备播放"], ["player-buffering", "播放缓冲"], ["player-transcoding", "音频转换"],
    ["player-offline", "播放连接中断"], ["player-missing", "音频文件缺失"], ["player-decode", "音频读取失败"], ["player-blocked", "等待点击播放"],
    ["lyrics-loading", "歌词载入中"], ["lyrics-error", "歌词载入失败"], ["lyrics-empty", "没有歌词"], ["queue-empty", "待播清单为空"]
  ] },
  { name: "歌单、搜索与保存", description: "管理自己的音乐，也照顾未完成的操作。", items: [
    ["playlists-empty", "还没有歌单"], ["playlist-empty", "歌单没有歌曲"], ["playlist-covers", "不同专辑数的歌单封面"], ["favorites-empty", "还没有收藏"],
    ["playlist-rename", "重命名歌单"], ["playlist-delete", "删除歌单确认"], ["playlist-order", "调整歌曲顺序"],
    ["save-pending", "正在保存"], ["save-error", "收藏保存失败"], ["playlist-save-error", "歌单保存失败"], ["search-artists", "艺人搜索结果"], ["search-partial", "搜索部分失败"], ["search-empty", "没有搜索结果"]
  ] },
  { name: "内容载入与资源缺省", description: "从整页到单个封面，都有合适的退路。", items: [
    ["albums-empty", "没有专辑"], ["artists-empty", "没有艺人"], ["list-loading", "列表载入中"], ["list-error", "列表载入失败"],
    ["detail-loading", "详情载入中"], ["detail-error", "详情载入失败"], ["more-error", "下一页载入失败"],
    ["artwork-missing", "封面缺失与读取失败"], ["metadata-empty", "元数据缺省"], ["not-found", "页面不存在"]
  ] }
] as const;
