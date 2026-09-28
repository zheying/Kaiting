import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { GripVertical, LoaderCircle } from "lucide-react";
import { moveItem } from "./prototype-state";

type OrderItem = { id: string; title: string; artist: string; artwork: ReactNode };
type RowBounds = { top: number; height: number };
type Drag = { from: number; to: number; offset: number; rows: RowBounds[] };
type Session = Drag & {
  mode: "pointer" | "keyboard";
  pointerId: number;
  startY: number;
  pointerY: number;
  grabOffset: number;
  active: boolean;
  handle: HTMLButtonElement;
  scroller: HTMLElement;
};

export function PlaylistOrderEditor({ items, onChange, onSave, onCancel, writeState }: {
  items: OrderItem[];
  onChange: (ids: string[]) => void;
  onSave: () => void;
  onCancel: () => void;
  writeState: "idle" | "saving" | "error";
}) {
  const instructionsId = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const frameRef = useRef(0);
  const latest = useRef({ items, onChange });
  latest.current = { items, onChange };
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const disabled = writeState !== "idle";

  function showPosition(session: Session) {
    setDrag((previous) => previous?.from === session.from && previous.to === session.to && previous.offset === session.offset
      ? previous : { from: session.from, to: session.to, offset: session.offset, rows: session.rows });
  }

  function finish(cancel: boolean) {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    window.cancelAnimationFrame(frameRef.current);
    const list = listRef.current;
    if (list?.hasPointerCapture(session.pointerId)) list.releasePointerCapture(session.pointerId);
    setDrag(null);
    if (!session.active) return;
    const { items: current, onChange: change } = latest.current;
    if (!cancel && session.from !== session.to) change(moveItem(current.map((item) => item.id), session.from, session.to - session.from));
    setAnnouncement(cancel ? `已取消移动，${current[session.from].title} 仍在第 ${session.from + 1} 首。`
      : `${current[session.from].title} 已移至第 ${session.to + 1} 首，保存顺序后生效。`);
    session.handle.focus({ preventScroll: true });
  }
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    const cancel = () => finishRef.current(true);
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && sessionRef.current?.mode === "pointer") { event.preventDefault(); cancel(); }
    };
    const onVisibility = () => { if (document.hidden) cancel(); };
    window.addEventListener("keydown", onEscape);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.cancelAnimationFrame(frameRef.current);
      sessionRef.current = null;
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  useEffect(() => { if (disabled) finishRef.current(true); }, [disabled]);

  function prepare(index: number, handle: HTMLButtonElement, mode: Session["mode"], pointerId = -1, y = 0) {
    const list = listRef.current;
    const scroller = list?.closest<HTMLElement>(".main-content");
    if (!list || !scroller || disabled || sessionRef.current) return null;
    const top = list.getBoundingClientRect().top;
    const rows = Array.from(list.children, (row) => {
      const rect = row.getBoundingClientRect();
      return { top: rect.top - top, height: rect.height };
    });
    const session: Session = { from: index, to: index, offset: 0, rows, mode, pointerId, startY: y, pointerY: y,
      grabOffset: y - top - rows[index].top, active: mode === "keyboard", handle, scroller };
    sessionRef.current = session;
    if (session.active) {
      showPosition(session);
      setAnnouncement(`已抓取 ${items[index].title}，当前第 ${index + 1} 首。用方向键调整，Home 置顶，End 置底，空格放下，Esc 取消。`);
    }
    return session;
  }

  function visibleBounds(session: Session) {
    const rect = session.scroller.getBoundingClientRect();
    const player = document.querySelector(".capsule-player")?.getBoundingClientRect();
    return { top: Math.max(rect.top + 64, toolbarRef.current?.getBoundingClientRect().bottom ?? rect.top),
      bottom: Math.min(rect.bottom, window.innerHeight, player ? player.top - 12 : window.innerHeight) };
  }

  function positionPointer(session: Session) {
    const list = listRef.current;
    if (!list) return;
    const row = session.rows[session.from];
    const bounds = visibleBounds(session);
    const pointer = Math.max(bounds.top + session.grabOffset, Math.min(session.pointerY, bounds.bottom - row.height + session.grabOffset));
    const last = session.rows[session.rows.length - 1];
    const top = Math.max(0, Math.min(pointer - list.getBoundingClientRect().top - session.grabOffset, last.top + last.height - row.height));
    session.offset = top - row.top;
    const center = top + row.height / 2;
    session.to = session.rows.reduce((closest, candidate, index, rows) =>
      Math.abs(candidate.top + candidate.height / 2 - center) < Math.abs(rows[closest].top + rows[closest].height / 2 - center) ? index : closest, 0);
    showPosition(session);
  }

  function autoScroll() {
    let previousTime = performance.now();
    const tick = (time: number) => {
      const session = sessionRef.current;
      if (!session?.active || session.mode !== "pointer") return;
      const { top, bottom } = visibleBounds(session);
      const edge = Math.min(56, (bottom - top) / 3);
      const speed = session.pointerY < top + edge ? -Math.min(1, (top + edge - session.pointerY) / edge)
        : session.pointerY > bottom - edge ? Math.min(1, (session.pointerY - bottom + edge) / edge) : 0;
      const distance = speed * Math.min(32, time - previousTime) * .65;
      const listBounds = listRef.current!.getBoundingClientRect();
      // Stop at the list edges instead of scrolling into the playlist hero or footer.
      session.scroller.scrollTop += distance < 0 ? Math.max(distance, Math.min(0, listBounds.top - top))
        : Math.min(distance, Math.max(0, listBounds.bottom - bottom));
      previousTime = time;
      positionPointer(session);
      frameRef.current = window.requestAnimationFrame(tick);
    };
    frameRef.current = window.requestAnimationFrame(tick);
  }

  function pointerDown(event: PointerEvent<HTMLButtonElement>, index: number) {
    if (!event.isPrimary || event.button !== 0) return;
    const session = prepare(index, event.currentTarget, "pointer", event.pointerId, event.clientY);
    if (!session) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    listRef.current?.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<HTMLOListElement>) {
    const session = sessionRef.current;
    if (!session || session.mode !== "pointer" || session.pointerId !== event.pointerId) return;
    session.pointerY = event.clientY;
    if (!session.active) {
      if (Math.abs(event.clientY - session.startY) < 5) return;
      session.active = true;
      autoScroll();
    }
    positionPointer(session);
  }

  function keyboardMove(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const session = sessionRef.current;
    if (session?.mode === "pointer") return;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (session) finish(false); else prepare(index, event.currentTarget, "keyboard");
      return;
    }
    if (!session) return;
    if (event.key === "Escape") { event.preventDefault(); finish(true); return; }
    if (event.key === "Tab") { finish(true); return; }
    const offsets: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 };
    if (!(event.key in offsets) && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    session.to = Math.max(0, Math.min(items.length - 1, event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : session.to + offsets[event.key]));
    session.offset = session.rows[session.to].top - session.rows[session.from].top;
    showPosition(session);
    setAnnouncement(`${items[session.from].title}，目标第 ${session.to + 1} 首，共 ${items.length} 首。`);
    window.requestAnimationFrame(() => session.handle.closest("li")?.scrollIntoView({ block: "nearest" }));
  }

  return <div className="playlist-order-editor" aria-busy={writeState === "saving"}>
    <div className="order-toolbar" ref={toolbarRef}>
      <span className="order-instructions"><strong>拖动右侧手柄调整顺序</strong><small>{drag ? `放到第 ${drag.to + 1} 首 · 松开后保存` : "拖至列表边缘可继续滚动，保存后生效"}</small></span>
      <div><button className="button subtle" disabled={writeState === "saving" || Boolean(drag)} onClick={onCancel}>取消</button><button className="button primary" disabled={disabled || Boolean(drag)} onClick={onSave}>{writeState === "saving" && <LoaderCircle className="button-spinner" aria-hidden="true" />}保存顺序</button></div>
    </div>
    <p id={instructionsId} className="sr-only">按住手柄拖动歌曲。键盘可按空格或回车抓取，用上下键移动、Home 置顶、End 置底，再按空格或回车放下，Esc 取消本次移动。</p>
    <div className="order-list-wrap">
      {drag && <div className="order-drop-slot" aria-hidden="true" style={{ top: drag.rows[drag.to].top, height: drag.rows[drag.from].height }} />}
      <ol className={`order-list${drag ? " is-sorting" : ""}`} ref={listRef} aria-label="歌曲排列顺序"
        onPointerMove={pointerMove}
        onPointerUp={(event) => { if (sessionRef.current?.pointerId === event.pointerId) { pointerMove(event); finish(false); } }}
        onPointerCancel={(event) => { if (sessionRef.current?.pointerId === event.pointerId) finish(true); }}
        onLostPointerCapture={(event) => { if (sessionRef.current?.pointerId === event.pointerId) finish(true); }}>
        {items.map((item, index) => {
          const active = drag?.from === index;
          const displaced = drag && (drag.from < index && index <= drag.to ? -1 : drag.to <= index && index < drag.from ? 1 : 0);
          const offset = active ? drag.offset : drag && displaced ? displaced * drag.rows[drag.from].height : 0;
          const position = active ? drag.to : index + (displaced || 0);
          return <li className={`order-row${active ? " is-dragging" : ""}`} key={item.id} style={{ transform: `translateY(${offset}px)` }}>
            <span className="order-number" aria-hidden="true">{String(position + 1).padStart(2, "0")}</span>
            {item.artwork}<span className="order-track"><strong>{item.title}</strong><small>{item.artist}</small></span>
            <button type="button" className="order-handle" aria-label={`调整 ${item.title} 的位置`} aria-describedby={instructionsId} aria-pressed={active} title="拖动调整顺序" disabled={disabled}
              onPointerDown={(event) => pointerDown(event, index)} onKeyDown={(event) => keyboardMove(event, index)}
              onBlur={() => { if (sessionRef.current?.mode === "keyboard") finish(true); }}
              onClick={(event) => { if (event.detail === 0) { if (sessionRef.current?.mode === "keyboard") finish(false); else prepare(index, event.currentTarget, "keyboard"); } }}><GripVertical aria-hidden="true" /></button>
          </li>;
        })}
      </ol>
    </div>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </div>;
}
