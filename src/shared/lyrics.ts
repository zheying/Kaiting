export type LyricWord = { text: string; time: number; end?: number };
export type LyricLine = { text: string; time: number | null; end?: number; words?: LyricWord[] };
export type LyricsResponse = { lines: LyricLine[] };

export function parseLyrics(text: string): LyricLine[] {
  const entries: LyricLine[] = [];
  const timestamp = /\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g;
  for (const raw of text.split(/\r?\n/)) {
    const times = [...raw.matchAll(timestamp)].map((match) => Number(match[1]) * 60 + Number(match[2]) + (match[3] ? Number(`0.${match[3]}`) : 0));
    const lyric = raw.replace(/\[[^\]]+\]/g, "").trim();
    if (times.length) for (const time of times) entries.push({ text: lyric, time });
    else if (lyric) entries.push({ text: lyric, time: null });
  }
  return normalizeLyricLines(entries);
}

export function normalizeLyricLines(entries: LyricLine[]): LyricLine[] {
  entries.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
  const lines: LyricLine[] = [];
  for (const entry of entries) {
    if (entry.text.trim()) lines.push(entry);
    else {
      // An empty timed LRC line marks an instrumental gap, not a visible lyric.
      const previous = lines.at(-1);
      if (previous?.time != null && entry.time !== null && previous.end === undefined) previous.end = entry.time;
    }
  }
  return lines;
}

export function activeLyricIndex(lines: LyricLine[], position: number): number {
  let active = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.time === null) continue;
    if (line.time > position) break;
    active = index;
  }
  return active >= 0 && lines[active].end !== undefined && position >= lines[active].end! ? -1 : active;
}

export function wordProgress(word: LyricWord, position: number): number {
  if (position < word.time) return 0;
  // Without an explicit end, highlight at the known start; never invent a duration.
  if (word.end === undefined || word.end <= word.time) return 1;
  return Math.min(1, (position - word.time) / (word.end - word.time));
}
