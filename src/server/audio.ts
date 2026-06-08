import path from "node:path";
import type { Track } from "../shared/types.js";

export const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".m4a",
  ".aac",
  ".flac",
  ".alac",
  ".ogg",
  ".opus",
  ".wav"
]);

export const COVER_FILE_NAMES = new Set([
  "cover.jpg",
  "cover.jpeg",
  "cover.png",
  "folder.jpg",
  "folder.jpeg",
  "folder.png",
  "front.jpg",
  "front.jpeg",
  "front.png"
]);

export function isSupportedAudioFile(filePath: string): boolean {
  return SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function inferFormatGroup(filePath: string, codec?: string | null, container?: string | null): string {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const normalizedCodec = (codec ?? "").toLowerCase();
  const normalizedContainer = (container ?? "").toLowerCase();

  if (ext === "m4a" || ext === "aac") {
    if (normalizedCodec.includes("alac") || normalizedCodec.includes("apple lossless")) return "alac";
    return "m4a";
  }

  if (normalizedCodec.includes("alac") || normalizedContainer.includes("alac")) return "alac";
  if (ext) return ext;
  return normalizedCodec || "unknown";
}

export function isM4aAlac(filePath: string, codec?: string | null, container?: string | null): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const normalizedCodec = (codec ?? "").toLowerCase();
  const normalizedContainer = (container ?? "").toLowerCase();
  return (ext === ".m4a" || ext === ".alac") && (
    normalizedCodec.includes("alac") ||
    normalizedCodec.includes("apple lossless") ||
    normalizedContainer.includes("apple lossless")
  );
}

export function directMimeType(track: Pick<Track, "path" | "codec" | "container" | "formatGroup">): string | null {
  const ext = path.extname(track.path).toLowerCase();
  const codec = (track.codec ?? "").toLowerCase();

  if (ext === ".mp3") return "audio/mpeg";
  if ((ext === ".m4a" || ext === ".aac") && !isM4aAlac(track.path, track.codec, track.container)) return "audio/mp4";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".opus") return "audio/ogg; codecs=opus";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".flac" && codec.includes("flac")) return "audio/flac";

  return null;
}

export function shouldTranscode(track: Pick<Track, "path" | "codec" | "container" | "formatGroup">): boolean {
  if (isM4aAlac(track.path, track.codec, track.container)) return true;
  const ext = path.extname(track.path).toLowerCase();
  return ext === ".flac" || ext === ".alac" || directMimeType(track) === null;
}
