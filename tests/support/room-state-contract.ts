import { describe, expect, it } from "vitest";
import type * as Production from "../../src/client/room/room-state.js";
export function roomStateContract({ moveItem, readable, trackTime, yearLabel }: Pick<typeof Production, "moveItem" | "readable" | "trackTime" | "yearLabel">) {
describe("歌单排序草稿", () => {
  it("调整草稿不会改动已保存顺序，歌曲没有丢失或重复", () => {
    const saved = ["a", "b", "c"];
    const draft = moveItem(saved, 0, 1);
    expect(saved).toEqual(["a", "b", "c"]);
    expect(draft).toEqual(["b", "a", "c"]);
    expect([...draft].sort()).toEqual([...saved].sort());
  });
  it("首尾边界与失效索引不改变列表", () => {
    const saved = ["a", "b"];
    expect(moveItem(saved, 0, -1)).toBe(saved);
    expect(moveItem(saved, 1, 1)).toBe(saved);
    expect(moveItem(saved, -1, 1)).toBe(saved);
    expect(moveItem([], 0, 1)).toEqual([]);
  });
  it("跨多首插入时保留其他歌曲的相对顺序", () => {
    const saved = ["a", "b", "c", "d", "e"];
    expect(moveItem(saved, 0, 4)).toEqual(["b", "c", "d", "e", "a"]);
    expect(moveItem(saved, 4, -4)).toEqual(["e", "a", "b", "c", "d"]);
    expect(moveItem(saved, 1, 2)).toEqual(["a", "c", "d", "b", "e"]);
    expect(saved).toEqual(["a", "b", "c", "d", "e"]);
  });
});

it("缺失元数据不显示空文本、零年份或无效时长", () => {
  expect(readable("  ", "未知艺人")).toBe("未知艺人");
  expect(readable(null, "未命名歌曲")).toBe("未命名歌曲");
  expect(yearLabel(null)).toBe("年份未知");
  expect(yearLabel(2023)).toBe("2023");
  expect(trackTime(0)).toBe("—");
  expect(trackTime(Number.NaN)).toBe("—");
  expect(trackTime(170)).toBe("2:50");
});
}
