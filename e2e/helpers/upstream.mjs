// 仅由 E2E 子进程 --import 加载；不进入产品构建。
// 保留实际元数据与歌词查询/匹配/限流，只替换外部网络边界。
const originalFetch = globalThis.fetch;
const origin = process.env.E2E_METADATA_ORIGIN;
if (!origin || new URL(origin).hostname !== "127.0.0.1") throw new Error("E2E 上游必须是本机隔离服务");
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["musicbrainz.org", "lrclib.net"].includes(url.hostname)) throw new Error(`E2E 禁止未声明的外部请求：${url.origin}`);
  return originalFetch(`${origin}/?url=${encodeURIComponent(url.href)}`, init);
};
