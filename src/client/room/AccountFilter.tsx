import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, CircleCheck, CirclePause, ShieldCheck, Users } from "lucide-react";

const options = [
  { value: "all", label: "全部账号", icon: Users },
  { value: "active", label: "可用账号", icon: CircleCheck },
  { value: "disabled", label: "已停用", icon: CirclePause },
  { value: "admin", label: "管理员", icon: ShieldCheck }
] as const;
export type AccountFilterValue = typeof options[number]["value"];

export function AccountFilter({ value, onChange }: { value: AccountFilterValue; onChange: (value: AccountFilterValue) => void }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = options.findIndex((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selected);
  const [placement, setPlacement] = useState({ above: false, maxHeight: 300 });

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (!root.current || !menu.current) return;
      const bounds = root.current.getBoundingClientRect();
      const scroller = root.current.closest(".main-content")?.getBoundingClientRect();
      const player = document.querySelector(".capsule-player")?.getBoundingClientRect();
      const topbar = document.querySelector(".topbar")?.getBoundingClientRect();
      const top = Math.max(16, scroller?.top ?? 16, (topbar?.bottom ?? 0) + 8);
      const bottom = Math.min(window.innerHeight, scroller?.bottom ?? window.innerHeight, player?.top ?? window.innerHeight);
      if (bounds.bottom < top || bounds.top > bottom) { setOpen(false); return; }
      const below = bottom - bounds.bottom - 16;
      const above = bounds.top - top - 16;
      const upward = below < menu.current.scrollHeight && above > below;
      const maxHeight = Math.max(80, upward ? above : below);
      setPlacement((previous) => previous.above === upward && previous.maxHeight === maxHeight ? previous : { above: upward, maxHeight });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open]);

  function expand(index = selected) { setActive(index); setOpen(true); }
  function choose(index: number) { onChange(options[index].value); setOpen(false); trigger.current?.focus({ preventScroll: true }); }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "Escape") {
      if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      return;
    }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open ? choose(active) : expand(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) expand();
      else setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (event.key === "Home" || event.key === "End") { event.preventDefault(); expand(event.key === "Home" ? 0 : options.length - 1); }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const match = options.findIndex((option) => option.label.startsWith(event.key));
      if (match >= 0) { event.preventDefault(); expand(match); }
    }
  }

  useEffect(() => {
    if (!open || !menu.current) return;
    const option = document.getElementById(`${id}-option-${active}`)?.getBoundingClientRect();
    if (!option) return;
    const bounds = menu.current.getBoundingClientRect();
    if (option.top < bounds.top + 6) menu.current.scrollTop -= bounds.top + 6 - option.top;
    else if (option.bottom > bounds.bottom - 6) menu.current.scrollTop += option.bottom - bounds.bottom + 6;
  }, [active, id, open, placement.maxHeight]);

  return <div ref={root} className="account-filter" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <span id={`${id}-label`} className="sr-only">筛选账号</span>
    <button ref={trigger} type="button" className={`account-filter-trigger ${value !== "all" ? "is-filtered" : ""}`} role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} aria-labelledby={`${id}-label ${id}-value`} aria-activedescendant={open ? `${id}-option-${active}` : undefined} onClick={() => open ? setOpen(false) : expand()} onKeyDown={onKeyDown}>
      <span id={`${id}-value`}>{options[selected].label}</span><ChevronDown aria-hidden="true" />
    </button>
    {open && <div ref={menu} className={`account-filter-menu ${placement.above ? "opens-above" : ""}`} style={{ maxHeight: placement.maxHeight }}>
      <div className="account-filter-caption" aria-hidden="true">筛选账号</div>
      <div id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`}>
        {options.map(({ value: optionValue, label, icon: Icon }, index) => <button key={optionValue} id={`${id}-option-${index}`} type="button" role="option" aria-selected={value === optionValue} tabIndex={-1} className={`account-filter-option ${active === index ? "is-active" : ""}`} onPointerMove={(event) => { if (event.pointerType === "mouse") setActive(index); }} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}>
          <Icon aria-hidden="true" /><span>{label}</span>{value === optionValue && <Check className="account-filter-check" aria-hidden="true" />}
        </button>)}
      </div>
    </div>}
  </div>;
}
