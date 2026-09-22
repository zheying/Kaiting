import { describe, expect, it } from "vitest";
import { createSeekGesture } from "../src/client/seek-input.js";

describe("range seek gestures", () => {
  it("does not seek when Tab, Shift+Tab, modifiers or ordinary blur only move focus", () => {
    const input = createSeekGesture("flac");
    for (const key of ["Tab", "Shift", "Tab", "Enter", "Escape", "a", " "]) {
      expect(input.keyDown(key, 18)).toBe(false);
      expect(input.keyUp(key)).toBeNull();
    }
    expect(input.blur()).toBeNull();
    expect(input.snapshot().seeking).toBe(false);
  });

  it("does not compare rounded DOM values against fractional playback time", () => {
    const input = createSeekGesture("flac-playing-at-18.47-seconds");
    // The actual range value is 18, even though the audio clock is fractional.
    input.keyDown("Home", 18);
    expect(input.keyUp("Home")).toBeNull();
    input.pointerDown(1, 18);
    input.change(18, 18);
    expect(input.pointerUp(1)).toBeNull();
    expect(input.blur()).toBeNull();
  });

  it("commits a repeated direction key only when released and never again on blur", () => {
    const input = createSeekGesture("track");
    input.keyDown("ArrowRight", 18);
    input.change(19, 18);
    input.keyDown("ArrowRight", 19);
    input.change(20, 18);
    input.keyDown("ArrowRight", 20);
    input.change(21, 18);
    expect(input.snapshot()).toMatchObject({ seeking: true, value: 21 });
    expect(input.keyUp("ArrowRight")).toBe(21);
    expect(input.keyUp("ArrowRight")).toBeNull();
    expect(input.blur()).toBeNull();
  });

  it("waits until all changing keys are released and ignores unrelated keyup", () => {
    const input = createSeekGesture("track");
    input.keyDown("ArrowRight", 18);
    input.change(19, 18);
    input.keyDown("ArrowUp", 19);
    input.change(20, 18);
    expect(input.keyUp("Tab")).toBeNull();
    expect(input.keyUp("ArrowRight")).toBeNull();
    expect(input.keyUp("ArrowUp")).toBe(20);
  });

  it("commits changed progress when focus leaves before keyup", () => {
    const input = createSeekGesture("track");
    input.keyDown("End", 18);
    input.change(120, 18);
    expect(input.blur()).toBe(120);
    expect(input.keyUp("End")).toBeNull();
  });

  it("does not seek at an unchanged range boundary or after returning to the starting value", () => {
    const input = createSeekGesture("track");
    input.keyDown("ArrowLeft", 0);
    input.change(0, 0);
    expect(input.keyUp("ArrowLeft")).toBeNull();
    input.pointerDown(7, 18);
    input.change(22, 18);
    input.change(18, 18);
    expect(input.pointerUp(7)).toBeNull();
  });

  it("commits a drag once for its captured pointer, ignoring a different pointer and lost capture after release", () => {
    const input = createSeekGesture("track");
    input.pointerDown(7, 18);
    input.change(22, 18);
    expect(input.pointerUp(8)).toBeNull();
    expect(input.snapshot().seeking).toBe(true);
    expect(input.pointerUp(7)).toBe(22);
    input.pointerCancel(7);
    expect(input.blur()).toBeNull();
  });

  it("discards a canceled drag, including late change and release events", () => {
    const input = createSeekGesture("track");
    input.pointerDown(7, 18);
    input.change(22, 18);
    input.pointerCancel(7);
    expect(input.change(23, 18)).toBe(false);
    expect(input.pointerUp(7)).toBeNull();
    expect(input.blur()).toBeNull();
    input.pointerDown(8, 30);
    input.change(32, 30);
    expect(input.pointerUp(8)).toBe(32);
  });

  it("drops pending progress and stale events on track change, then accepts a new gesture", () => {
    const input = createSeekGesture("old");
    input.keyDown("ArrowRight", 18);
    input.change(25, 18);
    input.changeTrack("new");
    expect(input.snapshot()).toMatchObject({ seeking: false, value: null });
    expect(input.change(26, 0)).toBe(false);
    expect(input.keyUp("ArrowRight")).toBeNull();
    expect(input.blur()).toBeNull();
    input.keyDown("Home", 5);
    input.change(0, 5);
    expect(input.keyUp("Home")).toBe(0);
  });

  it("ignores repeated keydown from a key still held while the track changes", () => {
    const input = createSeekGesture("old");
    input.keyDown("ArrowRight", 18);
    input.change(19, 18);
    input.changeTrack("new");
    expect(input.keyDown("ArrowRight", 0, true)).toBe(false);
    expect(input.change(1, 0)).toBe(false);
    expect(input.keyUp("ArrowRight")).toBeNull();
    input.keyDown("ArrowRight", 0);
    input.change(1, 0);
    expect(input.keyUp("ArrowRight")).toBe(1);
  });

  it("supports input changes without key events, such as assistive control, without duplicating a committed value", () => {
    const input = createSeekGesture("track");
    input.focus();
    expect(input.change(42, 18)).toBe(true);
    expect(input.blur()).toBe(42);
    expect(input.change(42, 42)).toBe(false);
    expect(input.blur()).toBeNull();
  });
});
