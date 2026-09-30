import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api.js";
import { createLatestRequest, playbackErrorMessage } from "../src/client/async-state.js";
afterEach(() => vi.unstubAllGlobals());
describe("legacy client lifecycle", () => {
  it("cancels superseded requests and rejects late results even when the transport ignores abort", async () => {
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(Response.json({ tracks: [{ id: "new" }], albums: [], artists: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const requests = createLatestRequest();
    const first = requests.begin();
    let visibleIds: string[] = [];
    const firstResult = api.search("old", first.signal).then((result) => {
      if (first.isCurrent()) visibleIds = result.tracks.map((track) => track.id);
    });
    const second = requests.begin();
    const secondResult = await api.search("new", second.signal);
    if (second.isCurrent()) visibleIds = secondResult.tracks.map((track) => track.id);
    resolveFirst(Response.json({ tracks: [{ id: "old" }], albums: [], artists: [] }));
    await firstResult;
    expect(first.signal.aborted).toBe(true);
    expect(fetchMock.mock.calls[0][1].signal).toBe(first.signal);
    expect(visibleIds).toEqual(["new"]);
  });

  it("invalidates pending play or detail callbacks on cancel without invalidating the next session", () => {
    const requests = createLatestRequest();
    const pending = requests.begin();
    requests.cancel();
    expect(pending.isCurrent()).toBe(false);
    expect(pending.signal.aborted).toBe(true);
    const resumed = requests.begin();
    expect(resumed.isCurrent()).toBe(true);
    expect(pending.isCurrent()).toBe(false);
  });

});

describe("playback failure feedback", () => {
  it("explains autoplay denial separately from network and codec failures", () => {
    expect(playbackErrorMessage(new DOMException("Denied", "NotAllowedError"))).toContain("点击重试");
    expect(playbackErrorMessage(null, 2)).toContain("NAS 连接");
    expect(playbackErrorMessage(null, 3)).toContain("解码失败");
    expect(playbackErrorMessage(null, 4)).toContain("转码服务");
    expect(playbackErrorMessage(new Error("Unexpected"))).toContain("播放失败");
  });
});
