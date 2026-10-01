import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export function AtmospherePanel({ kind, open, onClose, children }: {
  kind: "lyrics" | "queue"; open: boolean; onClose: () => void; children: ReactNode;
}) {
  const [present, setPresent] = useState(open);
  const element = useRef<HTMLElement>(null);
  const animation = useRef<Animation | null>(null);

  useLayoutEffect(() => { if (open) setPresent(true); }, [open]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || !present) return;
    // 快速反向切换从当前帧续接，不重置透明度，也不影响舞台的布局。
    const current = getComputedStyle(node);
    const from = { opacity: current.opacity, transform: current.transform };
    const to = { opacity: open ? "1" : "0", transform: open ? "translateY(0px)" : "translateY(8px)" };
    animation.current?.cancel();
    Object.assign(node.style, to);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (!open) setPresent(false);
      return;
    }
    const motion = node.animate([from, to], { duration: open ? 380 : 260, easing: "cubic-bezier(.22,.68,0,1)" });
    animation.current = motion;
    void motion.finished.then(() => { if (!open && animation.current === motion) setPresent(false); }).catch(() => {});
  }, [open, present]);
  useEffect(() => () => animation.current?.cancel(), []);

  if (!present) return null;
  return <aside ref={element} className={`av-companion av-companion-${kind}`} data-state={open ? "open" : "closing"}
    aria-label={kind === "lyrics" ? "氛围歌词面板" : "氛围待播面板"} aria-hidden={!open} inert={!open}>
    <button className="av-panel-close av-icon" onClick={onClose} aria-label={kind === "lyrics" ? "收起歌词" : "收起待播清单"}><X /></button>
    {children}
  </aside>;
}
