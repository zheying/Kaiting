import { describe, expect, it } from "vitest";
import { clampPlaybackPosition, isPlaybackAtEnd, playbackLoadPosition } from "../src/client/room/playback-position.js";

describe("completed playback positions", () => {
  const duration = 290.0125208333333;

  it("restores the exact completed FLAC position without requesting its empty tail", () => {
    expect(playbackLoadPosition(duration, duration, false)).toEqual({ position: duration, ended: true });
  });

  it("starts a completed track from zero when playback is requested", () => {
    expect(playbackLoadPosition(duration, duration, true)).toEqual({ position: 0, ended: false });
  });

  it("handles a saved position beyond the current track duration", () => {
    expect(playbackLoadPosition(300, duration, false)).toEqual({ position: duration, ended: true });
    expect(playbackLoadPosition(300, duration, true)).toEqual({ position: 0, ended: false });
  });

  it.each([0, 37.5, duration - 0.01])("retains an unfinished position of %s seconds", (position) => {
    expect(playbackLoadPosition(position, duration, false)).toEqual({ position, ended: false });
    expect(playbackLoadPosition(position, duration, true)).toEqual({ position, ended: false });
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])("does not infer completion for an unknown duration %s", (unknownDuration) => {
    expect(isPlaybackAtEnd(30, unknownDuration)).toBe(false);
    expect(playbackLoadPosition(30, unknownDuration, true)).toEqual({ position: 30, ended: false });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("safely normalizes an invalid position %s", (position) => {
    expect(clampPlaybackPosition(position, duration)).toBe(0);
    expect(playbackLoadPosition(position, duration, false)).toEqual({ position: 0, ended: false });
  });
});
