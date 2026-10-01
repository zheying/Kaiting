import { useEffect, useRef, useState } from "react";

// 仅演示连接状态与设置交互；实际探测由正式客户端处理。
export function MediaConnectionSettings({ automatic, onAutomaticChange }: { automatic: boolean; onAutomaticChange: (value: boolean) => void }) {
  const [route, setRoute] = useState<"probing" | "direct" | "public">("public");
  const timer = useRef<number | undefined>(undefined);
  function detect() {
    window.clearTimeout(timer.current);
    setRoute("probing");
    timer.current = window.setTimeout(() => setRoute("direct"), 850);
  }
  useEffect(() => {
    if (automatic) detect(); else setRoute("public");
    return () => window.clearTimeout(timer.current);
  }, [automatic]);
  const status = !automatic ? "仅使用公网中转" : route === "direct" ? "NAS 直连可用" : route === "probing" ? "正在检测直连…" : "公网中转";
  return <>
    <div className="setting-row"><span><strong>优先 NAS 直连</strong><small>音频和封面自动选择入口，连接失败时回退公网</small></span><button className={`toggle ${automatic ? "on" : ""}`} role="switch" aria-checked={automatic} aria-label="优先 NAS 直连" onClick={() => onAutomaticChange(!automatic)}><span /></button></div>
    <div className="setting-row"><span><strong data-testid="media-connection-status" role="status">{status}</strong><small>用于新的媒体请求，不打断正在播放的歌曲</small></span><button className="button" disabled={!automatic || route === "probing"} onClick={detect}>重新检测直连</button></div>
  </>;
}
