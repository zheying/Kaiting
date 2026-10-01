import { useSyncExternalStore } from "react";

type Connection = { enabled: boolean; publicOrigin?: string; directOrigin?: string; instance?: string };
type State = { enabled: boolean; automatic: boolean; route: "disabled" | "probing" | "direct" | "public" };
const preferenceKey = "kaiting.media-connection";
function automatic() { try { return localStorage.getItem(preferenceKey) !== "public"; } catch { return true; } }
let state: State = { enabled: false, automatic: automatic(), route: "disabled" };
let connection: Connection | undefined;
let active = false, generation = 0, attempt = 0, lastAttempt = 0, validUntil = 0;
let controller: AbortController | undefined;
const listeners = new Set<() => void>();
const snapshot = () => state;
function update(value: Partial<State>) { state = { ...state, ...value }; for (const listener of listeners) listener(); }
export function useMediaConnection() { return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, snapshot); }

async function json(url: string, signal: AbortSignal, init: RequestInit = {}, timeout = 3000) {
  const request = new AbortController();
  const cancel = () => request.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) request.abort();
  const timer = setTimeout(cancel, timeout);
  try {
    const response = await fetch(url, { ...init, credentials: "include", cache: "no-store", redirect: "error", signal: request.signal });
    if (!response.ok) throw new Error("媒体连接不可用");
    return await response.json();
  } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
}
export async function retryMediaConnection() {
  if (!active || !connection?.enabled || !connection.directOrigin || !state.automatic) return;
  controller?.abort(); controller = new AbortController();
  const signal = controller.signal; const current = ++attempt; const lifecycle = generation;
  lastAttempt = Date.now();
  const wasDirect = state.route === "direct" && validUntil > Date.now();
  if (!wasDirect) update({ route: "probing" });
  try {
    const probe = await json(`${connection.directOrigin}/api/media/probe`, signal, {}, 1800);
    if (probe.instance !== connection.instance) throw new Error("不是同一音乐室");
    const { ticket } = await json("/api/media/connection", signal, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await json(`${connection.directOrigin}/api/media/connect`, signal, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }) });
    // 成功响应不代表浏览器接受了 Cookie，必须再验证一次实际读取。
    await json(`${connection.directOrigin}/api/media/status`, signal);
    if (current !== attempt || lifecycle !== generation || signal.aborted) return;
    validUntil = Date.now() + 14 * 60_000;
    update({ route: "direct" });
  } catch {
    if (current === attempt && lifecycle === generation && !signal.aborted) { validUntil = 0; update({ route: "public" }); }
  }
}
export function setAutomaticMediaConnection(value: boolean) {
  try { localStorage.setItem(preferenceKey, value ? "auto" : "public"); } catch { /* 私密浏览不影响当前页偏好。 */ }
  ++attempt; controller?.abort(); validUntil = 0;
  update({ automatic: value, route: connection?.enabled ? "public" : "disabled" });
  if (value) void retryMediaConnection();
}
export function startMediaConnection() {
  active = true; const lifecycle = ++generation;
  connection = undefined; validUntil = 0;
  update({ enabled: false, route: "disabled", automatic: automatic() });
  controller?.abort(); controller = new AbortController();
  const signal = controller.signal;
  void json("/api/media/connection", signal).then((value: Connection) => {
    if (lifecycle !== generation || signal.aborted) return;
    if (!value.enabled || value.publicOrigin !== window.location.origin || !value.directOrigin || !value.instance) return;
    connection = value; update({ enabled: true, route: "public" });
    void retryMediaConnection();
  }).catch(() => { /* 不支持直连的旧服务继续使用页面入口。 */ });
  const reconnect = () => {
    if (document.visibilityState !== "hidden" && Date.now() - lastAttempt > 60_000) void retryMediaConnection();
  };
  const refresh = setInterval(() => {
    if (state.route === "direct" && Date.now() > validUntil - 4 * 60_000) void retryMediaConnection();
  }, 60_000);
  window.addEventListener("online", reconnect); window.addEventListener("pageshow", reconnect);
  document.addEventListener("visibilitychange", reconnect);
  return () => {
    active = false; ++generation; ++attempt; controller?.abort(); connection = undefined; validUntil = 0;
    clearInterval(refresh); window.removeEventListener("online", reconnect); window.removeEventListener("pageshow", reconnect);
    document.removeEventListener("visibilitychange", reconnect);
    update({ enabled: false, route: "disabled" });
  };
}
const mediaPath = /^\/api\/tracks\/[^/?#]+\/(stream|artwork)(?:\?|$)/;
export function mediaUrl(path: string, forcePublic = false) {
  return !forcePublic && state.automatic && state.route === "direct" && validUntil > Date.now() && connection?.directOrigin && mediaPath.test(path) ? connection.directOrigin + path : path;
}
export function isDirectMediaUrl(url: string) {
  return Boolean(connection?.directOrigin && url.startsWith(connection.directOrigin + "/api/tracks/"));
}
export function mediaConnectionFailed(url: string) {
  if (!isDirectMediaUrl(url)) return false;
  ++attempt; controller?.abort(); validUntil = 0; lastAttempt = Date.now();
  update({ route: "public" });
  return true;
}
