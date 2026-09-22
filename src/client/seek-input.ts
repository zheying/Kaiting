import { useLayoutEffect, useRef, useState, type ComponentPropsWithRef } from "react";

const RANGE_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

type TrackIdentity = string | null | undefined;
type Gesture = {
  kind: "pointer" | "keyboard" | "implicit";
  baseline: number;
  value: number;
  pointerId: number | null;
  keys: Set<string>;
};

/** Range gestures compare against the DOM value, which may round playback time. */
export function createSeekGesture(trackId: TrackIdentity) {
  let track = trackId;
  let gesture: Gesture | null = null;
  let ignoreImplicitChanges = false;
  const suppressedKeys = new Set<string>();

  function begin(kind: Gesture["kind"], baseline: number, pointerId: number | null = null) {
    gesture = { kind, baseline, value: baseline, pointerId, keys: new Set() };
    ignoreImplicitChanges = false;
  }

  function finish(): number | null {
    const previous = gesture;
    gesture = null;
    if (!previous || previous.value === previous.baseline) return null;
    return previous.value;
  }

  return {
    snapshot: () => ({ seeking: gesture !== null, value: gesture?.value ?? null, pointerId: gesture?.pointerId ?? null }),
    changeTrack(nextTrack: TrackIdentity) {
      if (track === nextTrack) return;
      track = nextTrack;
      if (gesture?.kind === "keyboard") for (const key of gesture.keys) suppressedKeys.add(key);
      gesture = null;
      ignoreImplicitChanges = true;
    },
    focus() {
      if (!gesture) ignoreImplicitChanges = false;
    },
    pointerDown(pointerId: number, domValue: number) {
      begin("pointer", domValue, pointerId);
    },
    pointerUp(pointerId: number): number | null {
      return gesture?.kind === "pointer" && gesture.pointerId === pointerId ? finish() : null;
    },
    pointerCancel(pointerId: number) {
      if (gesture?.kind !== "pointer" || gesture.pointerId !== pointerId) return;
      gesture = null;
      ignoreImplicitChanges = true;
    },
    keyDown(key: string, domValue: number, repeat = false): boolean {
      if (!RANGE_KEYS.has(key) || gesture?.kind === "pointer") return false;
      if (suppressedKeys.has(key)) {
        if (repeat) return false;
        suppressedKeys.delete(key);
      }
      if (gesture?.kind !== "keyboard") begin("keyboard", domValue);
      gesture!.keys.add(key);
      return true;
    },
    keyUp(key: string): number | null {
      if (suppressedKeys.delete(key)) return null;
      if (!RANGE_KEYS.has(key) || gesture?.kind !== "keyboard" || !gesture.keys.has(key)) return null;
      gesture.keys.delete(key);
      return gesture.keys.size === 0 ? finish() : null;
    },
    change(value: number, domBaseline: number): boolean {
      if (!Number.isFinite(value)) return false;
      if (!gesture) {
        if (ignoreImplicitChanges || value === domBaseline) return false;
        begin("implicit", domBaseline);
      }
      gesture!.value = value;
      return true;
    },
    blur: finish,
    cancel() {
      gesture = null;
      ignoreImplicitChanges = true;
    }
  };
}

type SeekInputProps = Pick<ComponentPropsWithRef<"input">,
  "ref" | "onChange" | "onFocus" | "onPointerDown" | "onPointerUp" | "onPointerCancel" | "onLostPointerCapture" | "onKeyDown" | "onKeyUp" | "onBlur"
>;

interface SeekInputOptions {
  position: number;
  duration: number;
  trackId: TrackIdentity;
  onSeek: (position: number) => void;
}

function releasePointer(input: HTMLInputElement | null, pointerId: number | null) {
  if (!input || pointerId === null) return;
  try { if (input.hasPointerCapture(pointerId)) input.releasePointerCapture(pointerId); }
  catch { /* A canceled or detached input may already have released capture. */ }
}

export function useSeekInput({ position, duration, trackId, onSeek }: SeekInputOptions): { value: number; seeking: boolean; inputProps: SeekInputProps } {
  const inputRef = useRef<HTMLInputElement>(null);
  const gestureRef = useRef(createSeekGesture(trackId));
  const trackRef = useRef(trackId);
  const releaseAfterRender = useRef<number | null>(null);
  const domBaseline = useRef(0);
  const [, rerender] = useState(0);
  const gesture = gestureRef.current;
  const maximum = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const clamp = (value: number) => Math.max(0, Math.min(Number.isFinite(value) ? value : 0, maximum));

  if (trackRef.current !== trackId) {
    releaseAfterRender.current = gesture.snapshot().pointerId;
    gesture.changeTrack(trackId);
    trackRef.current = trackId;
  }
  const snapshot = gesture.snapshot();
  const value = clamp(snapshot.value ?? position);

  useLayoutEffect(() => {
    if (releaseAfterRender.current !== null) {
      releasePointer(inputRef.current, releaseAfterRender.current);
      releaseAfterRender.current = null;
    }
    if (!gesture.snapshot().seeking && inputRef.current) domBaseline.current = Number(inputRef.current.value);
  });

  useLayoutEffect(() => () => {
    const pointerId = gesture.snapshot().pointerId;
    gesture.cancel();
    releasePointer(inputRef.current, pointerId);
  }, []);

  function update() { rerender((version) => version + 1); }
  function commit(next: number | null) {
    update();
    if (next === null) return;
    domBaseline.current = next;
    onSeek(clamp(next));
  }

  const inputProps: SeekInputProps = {
    ref: inputRef,
    onFocus(event) {
      if (!gesture.snapshot().seeking) domBaseline.current = Number(event.currentTarget.value);
      gesture.focus();
    },
    onChange(event) {
      if (gesture.change(Number(event.currentTarget.value), domBaseline.current)) update();
    },
    onPointerDown(event) {
      if (event.button !== 0 || event.defaultPrevented) return;
      gesture.pointerDown(event.pointerId, Number(event.currentTarget.value));
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Native dragging still works when capture is unavailable. */ }
      update();
    },
    onPointerUp(event) {
      try { commit(gesture.pointerUp(event.pointerId)); }
      finally { releasePointer(event.currentTarget, event.pointerId); }
    },
    onPointerCancel(event) {
      gesture.pointerCancel(event.pointerId);
      releasePointer(event.currentTarget, event.pointerId);
      update();
    },
    onLostPointerCapture(event) {
      gesture.pointerCancel(event.pointerId);
      update();
    },
    onKeyDown(event) {
      if (!event.defaultPrevented && gesture.keyDown(event.key, Number(event.currentTarget.value), event.repeat)) update();
    },
    onKeyUp(event) {
      if (!RANGE_KEYS.has(event.key)) return;
      commit(gesture.keyUp(event.key));
    },
    onBlur(event) {
      const pointerId = gesture.snapshot().pointerId;
      try { commit(gesture.blur()); }
      finally { releasePointer(event.currentTarget, pointerId); }
    }
  };
  return { value, seeking: snapshot.seeking, inputProps };
}
