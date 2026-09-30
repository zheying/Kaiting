import { isNode, parseDocument, visit } from "yaml";
import { normalizeLyricLines, parseLyrics, type LyricLine, type LyricWord } from "../shared/lyrics.js";

export type LyricsDocument = { text: string; lines: LyricLine[] };
const MAX_BYTES = 1_000_000;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const milliseconds = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 86_400_000;
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 10_000;

function parseWords(value: unknown, line: LyricLine): LyricWord[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 2000) return undefined;
  const words: LyricWord[] = [];
  for (const entry of value) {
    if (!object(entry) || !text(entry.text) || !entry.text || !milliseconds(entry.start_ms)
      || (entry.end_ms !== undefined && (!milliseconds(entry.end_ms) || entry.end_ms < entry.start_ms))) return undefined;
    const time = entry.start_ms / 1000;
    const end = entry.end_ms === undefined ? undefined : (entry.end_ms as number) / 1000;
    if (time < line.time! || time < (words.at(-1)?.time ?? 0)
      || (line.end !== undefined && (time > line.end || (end !== undefined && end > line.end)))) return undefined;
    words.push({ text: entry.text, time, ...(end === undefined ? {} : { end }) });
  }
  return words.map((word) => word.text).join("") === line.text ? words : undefined;
}

export function parseLyricsfile(source: unknown): LyricsDocument | null {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_BYTES) return null;
  try {
    const document = parseDocument(source, { schema: "core", resolveKnownTags: false, uniqueKeys: true, strict: true });
    if (document.errors.length || document.warnings.length) return null;
    visit(document, (_key, node, ancestors) => {
      if (ancestors.length > 24 || (isNode(node) && node.tag && !node.tag.startsWith("tag:yaml.org,2002:"))) throw new Error("Invalid lyrics document");
    });
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!object(value) || value.version !== "1.0" || !object(value.metadata)) return null;
    const meta = value.metadata;
    if (!text(meta.title) || !text(meta.artist) || meta.instrumental === true
      // Lyricsfile 1.0 has not yet defined offset semantics; use legacy LRC instead.
      || (meta.offset_ms !== undefined && meta.offset_ms !== 0)
      || (meta.duration_ms !== undefined && !milliseconds(meta.duration_ms))) return null;
    if (!Array.isArray(value.lines) || !value.lines.length) {
      return typeof value.plain === "string" && value.plain.trim()
        ? { text: value.plain, lines: value.plain.split(/\r?\n/).filter((line) => line.trim()).map((line) => ({ text: line, time: null })) } : null;
    }
    if (value.lines.length > 3000) return null;
    const lines: LyricLine[] = [];
    for (const entry of value.lines) {
      if (!object(entry) || !text(entry.text) || !milliseconds(entry.start_ms)
        || (entry.end_ms !== undefined && (!milliseconds(entry.end_ms) || entry.end_ms < entry.start_ms))) return null;
      const line: LyricLine = { text: entry.text, time: entry.start_ms / 1000 };
      if (entry.end_ms !== undefined) line.end = (entry.end_ms as number) / 1000;
      const words = parseWords(entry.words, line);
      if (words) line.words = words;
      lines.push(line);
    }
    const normalized = normalizeLyricLines(lines);
    return { text: toLrc(lines), lines: normalized };
  } catch { return null; }
}

function toLrc(lines: LyricLine[]): string {
  return lines.map((line) => {
    const ms = Math.round(line.time! * 1000);
    return `[${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}]${line.text}`;
  }).join("\n");
}

export function readLyricsDocument(source: string, structured: boolean): LyricsDocument | null {
  if (!structured) return { text: source, lines: parseLyrics(source) };
  if (Buffer.byteLength(source) > MAX_BYTES * 4) return null;
  const seconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86400;
  try {
    const value: unknown = JSON.parse(source);
    if (!object(value) || value.version !== 1 || typeof value.text !== "string" || !Array.isArray(value.lines) || value.lines.length > 3000) return null;
    const lines: LyricLine[] = [];
    for (const entry of value.lines) {
      if (!object(entry) || !text(entry.text) || (entry.time !== null && !seconds(entry.time))
        || (entry.end !== undefined && (!seconds(entry.end) || entry.time === null || entry.end < entry.time))) return null;
      const line: LyricLine = { text: entry.text, time: entry.time, ...(entry.end === undefined ? {} : { end: entry.end as number }) };
      if (entry.words !== undefined) {
        if (line.time === null || !Array.isArray(entry.words) || entry.words.length > 2000) return null;
        const words: LyricWord[] = [];
        for (const word of entry.words) {
          if (!object(word) || !text(word.text) || !seconds(word.time) || word.time < Math.max(line.time, words.at(-1)?.time ?? 0)
            || (word.end !== undefined && (!seconds(word.end) || word.end < word.time))
            || (line.end !== undefined && (word.time > line.end || (seconds(word.end) && word.end > line.end)))) return null;
          words.push({ text: word.text, time: word.time, ...(word.end === undefined ? {} : { end: word.end as number }) });
        }
        if (words.map((word) => word.text).join("") !== line.text) return null;
        if (words.length) line.words = words;
      }
      lines.push(line);
    }
    lines.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
    return { text: value.text, lines };
  } catch { return null; }
}
