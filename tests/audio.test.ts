import { describe, expect, it } from "vitest";
import { directMimeType, inferFormatGroup, isM4aAlac, isSupportedAudioFile, shouldTranscode } from "../src/server/audio.js";

describe("audio format policy", () => {
  it("supports planned library extensions", () => {
    expect(isSupportedAudioFile("/music/a.mp3")).toBe(true);
    expect(isSupportedAudioFile("/music/a.m4a")).toBe(true);
    expect(isSupportedAudioFile("/music/a.flac")).toBe(true);
    expect(isSupportedAudioFile("/music/a.opus")).toBe(true);
    expect(isSupportedAudioFile("/music/a.txt")).toBe(false);
  });

  it("treats AAC M4A as directly playable", () => {
    const track = { path: "/music/song.m4a", codec: "AAC", container: "MPEG-4", formatGroup: "m4a" };
    expect(isM4aAlac(track.path, track.codec, track.container)).toBe(false);
    expect(inferFormatGroup(track.path, track.codec, track.container)).toBe("m4a");
    expect(directMimeType(track)).toBe("audio/mp4");
    expect(shouldTranscode(track)).toBe(false);
  });

  it("uses the AAC MIME type for directly playable raw AAC files", () => {
    const track = { path: "/music/song.aac", codec: "AAC", container: "ADTS", formatGroup: "m4a" };
    expect(directMimeType(track)).toBe("audio/aac");
    expect(shouldTranscode(track)).toBe(false);
  });

  it("detects ALAC M4A and forces transcode", () => {
    const track = { path: "/music/lossless.m4a", codec: "ALAC", container: "MPEG-4", formatGroup: "alac" };
    expect(isM4aAlac(track.path, track.codec, track.container)).toBe(true);
    expect(inferFormatGroup(track.path, track.codec, track.container)).toBe("alac");
    expect(shouldTranscode(track)).toBe(true);
  });
});
