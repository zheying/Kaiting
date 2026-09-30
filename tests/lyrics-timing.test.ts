import { describe, expect, it } from "vitest";
import { parseLyricsfile, readLyricsDocument } from "../src/server/lyrics-document.js";
import { activeLyricIndex, parseLyrics, wordProgress } from "../src/shared/lyrics.js";

const line = { text: "风 停了", start_ms: 1000, end_ms: 5000, words: [
  { text: "风 ", start_ms: 1000, end_ms: 1500 },
  { text: "停了", start_ms: 3000, end_ms: 5000 }
] };
const file = (lines: unknown[] = [line], metadata: object = {}, version = "1.0") => JSON.stringify({
  version, metadata: { title: "测试曲", artist: "测试艺人", ...metadata }, lines
});

describe("真实歌词时间轴", () => {
  it("保留不均匀的词时长、停顿和空格，进度仅来自各词的时间", () => {
    const lines = parseLyricsfile(file())!.lines;
    expect(lines[0].words).toEqual([
      { text: "风 ", time: 1, end: 1.5 }, { text: "停了", time: 3, end: 5 }
    ]);
    const [first, second] = lines[0].words!;
    expect(wordProgress(first, 1.25)).toBe(.5);
    expect(wordProgress(first, 2)).toBe(1);
    expect(wordProgress(second, 2)).toBe(0);
    expect(wordProgress(second, 4)).toBe(.5);
    // 回拖与暂停不依赖之前的动画状态。
    expect(wordProgress(second, 1)).toBe(0);
    expect(wordProgress(second, 4)).toBe(.5);
    expect(activeLyricIndex(lines, .9)).toBe(-1);
    expect(activeLyricIndex(lines, 5.1)).toBe(-1);
  });

  it("支持标准 YAML、混合逐句与逐词；缺少词结束时间只在起点高亮", () => {
    const document = parseLyricsfile(`version: '1.0'
metadata:
  title: 测试曲
  artist: 测试艺人
lines:
  - text: 风来
    start_ms: 1000
    words:
      - { text: 风, start_ms: 1000 }
      - { text: 来, start_ms: 2500 }
  - { text: 雨停, start_ms: 4000 }
`)!;
    expect(document.lines[0].words!.map((word) => word.text).join("")).toBe("风来");
    expect(wordProgress(document.lines[0].words![1], 2)).toBe(0);
    expect(wordProgress(document.lines[0].words![1], 2.5)).toBe(1);
    expect(document.lines[1].words).toBeUndefined();
  });

  it.each([
    [{ text: "不同文本", start_ms: 1000 }],
    [{ text: "风 ", start_ms: 3000 }, { text: "停了", start_ms: 2000 }],
    [{ text: "风 停了", start_ms: -1 }],
    [{ text: "风 停了", start_ms: 2000, end_ms: 1000 }],
    [{ text: "风 停了", start_ms: 6000 }],
    [{ text: "风 停了", start_ms: 1000.5 }]
  ].map((words) => [words]))("错误的词时间或文本降为逐句，不丢弃可用歌词 %#", (words) => {
    const result = parseLyricsfile(file([{ ...line, words }]))!;
    expect(result.lines).toEqual([{ text: "风 停了", time: 1, end: 5 }]);
  });

  it("不猜测未知格式或未定义的全局偏移，拒绝不安全 YAML", () => {
    for (const input of [file([], {}, "2.0"), file([line], { offset_ms: 100 }),
      file([{ ...line, start_ms: -1 }]), "version: '1.0'\nversion: '1.0'",
      "version: '1.0'\nmetadata: &a { title: 测试, artist: *a }", "!!js/function 'bad'",
      "a".repeat(1_000_001), "[".repeat(100) + "0" + "]".repeat(100)]) {
      expect(parseLyricsfile(input)).toBeNull();
    }
  });

  it("逐句 LRC 和纯文本不制造词时间，间奏及前奏没有错误的当前句", () => {
    const lines = parseLyrics("[00:01.00]风来了\n[00:03.00]\n[00:05.00]雨停了");
    expect(lines.map((item) => item.words)).toEqual([undefined, undefined]);
    expect(activeLyricIndex(lines, 0)).toBe(-1);
    expect(activeLyricIndex(lines, 2)).toBe(0);
    expect(activeLyricIndex(lines, 4)).toBe(-1);
    expect(activeLyricIndex(lines, 5)).toBe(1);
    expect(parseLyrics("只有一行文字")).toEqual([{ text: "只有一行文字", time: null }]);
  });

  it("缓存重读保留原始文本、逐词精度和无时间的附注，损坏内容不冒充歌词", () => {
    const document = parseLyricsfile(file())!;
    document.lines.push({ text: "测试附注", time: null });
    expect(readLyricsDocument(JSON.stringify({ version: 1, ...document }), true)).toEqual(document);
    expect(readLyricsDocument('{"version":1,"text":"旧文本","lines":[null]}', true)).toBeNull();
    expect(readLyricsDocument('{broken', true)).toBeNull();
  });

  it("在线时间轴的空白行表示间奏，不能显示为可点击的空歌词", () => {
    const lines = parseLyricsfile(file([{ text: "风起", start_ms: 1000 }, { text: "", start_ms: 3000 }, { text: "雨落", start_ms: 5000 }]))!.lines;
    expect(lines).toEqual([{ text: "风起", time: 1, end: 3 }, { text: "雨落", time: 5 }]);
    expect(activeLyricIndex(lines, 4)).toBe(-1);
  });
});
