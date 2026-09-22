import { describe, expect, it, vi } from "vitest";
import { loadValidPage } from "../src/client/library-pages.js";

describe("library page recovery", () => {
  it("returns to the last populated page when a favorite or a scan removes the previous final page", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ items: [], total: 40, offset: 60, limit: 30 })
      .mockResolvedValueOnce({ items: ["last"], total: 40, offset: 30, limit: 30 });
    const controller = new AbortController();
    expect(await loadValidPage(load, 60, controller.signal)).toEqual({ items: ["last"], total: 40, offset: 30, limit: 30 });
    expect(load.mock.calls.map(([offset]) => offset)).toEqual([60, 30]);
  });

  it("recovers an emptied collection to page zero", async () => {
    const load = vi.fn().mockImplementation(async (offset) => ({ items: [], total: 0, offset, limit: 30 }));
    expect((await loadValidPage(load, 60, new AbortController().signal)).offset).toBe(0);
    expect(load.mock.calls.map(([offset]) => offset)).toEqual([60, 0]);
  });

  it("does not hand back a late page when cancellation is ignored by the transport", async () => {
    const controller = new AbortController();
    const load = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { items: ["stale"], total: 1, offset: 0, limit: 30 };
    });
    await expect(loadValidPage(load, 0, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops retrying when concurrent removal continually invalidates the last page", async () => {
    const load = vi.fn().mockResolvedValue({ items: [], total: 0, offset: 30, limit: 30 });
    await expect(loadValidPage(load, 90, new AbortController().signal)).rejects.toThrow("曲库正在变化");
    expect(load).toHaveBeenCalledTimes(3);
  });
});
