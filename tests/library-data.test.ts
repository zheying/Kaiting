import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api.js";
import { collectTrackPages } from "../src/client/library-data.js";
import type { Page } from "../src/shared/types.js";

type Item = { id: string };
const tracks = Array.from({ length: 1054 }, (_, index) => ({ id: `track-${index}` }));
const page = (offset: number, limit: number): Page<Item> => ({
  items: tracks.slice(offset, offset + limit), total: tracks.length, offset, limit
});

afterEach(() => vi.unstubAllGlobals());

describe("complete playback queue collection", () => {
  it("explains network failures in Chinese without treating cancellation as a failure", async () => {
    const aborted = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockRejectedValueOnce(aborted));
    await expect(api.trackPage()).rejects.toThrow("无法连接服务，请检查网络后重试。");
    await expect(api.trackPage()).rejects.toBe(aborted);
  });

  it("collects all 1054 tracks in stable order across three bounded requests", async () => {
    const fetchPage = vi.fn(async (offset: number, limit: number) => page(offset, limit));
    const progress = vi.fn();
    expect(await collectTrackPages(fetchPage, undefined, progress)).toEqual(tracks);
    expect(fetchPage.mock.calls).toEqual([[0, 500], [500, 500], [1000, 500]]);
    expect(progress.mock.calls).toEqual([[500, 1054], [1000, 1054], [1054, 1054]]);
  });

  it("handles an empty library without requesting another page", async () => {
    const fetchPage = vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 500 }));
    expect(await collectTrackPages(fetchPage)).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("rejects a later failure rather than returning the first page as the entire queue", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(page(0, 500)).mockRejectedValueOnce(new Error("连接中断"));
    await expect(collectTrackPages(fetchPage)).rejects.toThrow("连接中断");
  });

  it.each(["total", "duplicate", "empty"])("rejects inconsistent %s while collecting a changing library", async (kind) => {
    const second = page(500, 500);
    if (kind === "total") second.total -= 1;
    if (kind === "duplicate") second.items[0] = tracks[0];
    if (kind === "empty") second.items = [];
    const fetchPage = vi.fn().mockResolvedValueOnce(page(0, 500)).mockResolvedValueOnce(second);
    await expect(collectTrackPages(fetchPage)).rejects.toThrow("曲库内容已变化");
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("cancels collection even if a pending transport ignores AbortSignal", async () => {
    const controller = new AbortController();
    let resolve!: (page: Page<Item>) => void;
    const fetchPage = vi.fn(() => new Promise<Page<Item>>((done) => { resolve = done; }));
    const progress = vi.fn();
    const collection = collectTrackPages(fetchPage, controller.signal, progress);
    controller.abort();
    resolve(page(0, 500));
    await expect(collection).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(progress).not.toHaveBeenCalled();
  });

  it("rejects a mixed snapshot when removals and additions leave the total unchanged", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ items: [{ id: "a" }, { id: "b" }], total: 4, offset: 0, limit: 2, revision: "before" })
      .mockResolvedValueOnce({ items: [{ id: "d" }, { id: "z" }], total: 4, offset: 2, limit: 2, revision: "after" });
    // [a,b,c,d] became [b,c,d,z]; totals and unique IDs alone would miss c.
    await expect(collectTrackPages(fetchPage)).rejects.toThrow("曲库内容已变化");
  });

  it("does not start a request that was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchPage = vi.fn();
    await expect(collectTrackPages(fetchPage, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("preserves search/favorite filters and cancellation on every page", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      return Response.json(page(Number(params.get("offset")), Number(params.get("limit"))));
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await api.allTracks({ q: "100% Love / 夜曲", favorite: true }, signal)).toEqual(tracks);
    for (const [url, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      const params = new URL(url, "http://localhost").searchParams;
      expect(params.get("page")).toBe("true");
      expect(params.get("q")).toBe("100% Love / 夜曲");
      expect(params.get("favorite")).toBe("true");
      expect(init.signal).toBe(signal);
    }
  });
});
