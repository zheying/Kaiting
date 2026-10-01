import { retryMediaConnection, setAutomaticMediaConnection, useMediaConnection } from "../media-connection.js";

export function MediaConnectionSettings() {
  const state = useMediaConnection();
  if (!state.enabled) return null;
  const status = !state.automatic ? "仅使用公网中转" : state.route === "direct" ? "NAS 直连可用" : state.route === "probing" ? "正在检测直连…" : "公网中转";
  return <>
    <div className="setting-row"><span><strong>优先 NAS 直连</strong><small>音频和封面自动选择入口，连接失败时回退公网</small></span><button className={`toggle ${state.automatic ? "on" : ""}`} role="switch" aria-checked={state.automatic} aria-label="优先 NAS 直连" onClick={() => setAutomaticMediaConnection(!state.automatic)}><span /></button></div>
    <div className="setting-row"><span><strong data-testid="media-connection-status" role="status">{status}</strong><small>用于新的媒体请求，不打断正在播放的歌曲</small></span><button className="button" disabled={!state.automatic || state.route === "probing"} onClick={() => { void retryMediaConnection(); }}>重新检测直连</button></div>
  </>;
}
