import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api.js";
import { createLatestRequest, playbackErrorMessage, scanJustFinished } from "../src/client/async-state.js";
import type { ScanJob } from "../src/shared/types.js";

function scan(id: string, status: ScanJob["status"]): ScanJob {
  return { id, status, startedAt: null, finishedAt: null, totalFiles: 1, scannedFiles: 1, parsedFiles: 1, skippedFiles: 0, force: false, prune: false, errorCount: 0, message: null };
}

afterEach(() => vi.unstubAllGlobals());

describe("client request lifecycle", () => {
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

  it("forwards cancellation for detail and polling endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({})));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    await Promise.all([api.album("100%", signal), api.artist("AC/DC", signal), api.playlist("list", signal), api.tracks("?favorite=true", signal), api.scanStatus(signal)]);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/albums/100%25", "/api/artists/AC%2FDC", "/api/playlists/list", "/api/tracks?favorite=true", "/api/scan"
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init.signal === signal)).toBe(true);
  });

  it("surfaces server failures so the caller can display a retry action", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "曲库暂时不可用" }, { status: 503 })));
    await expect(api.search("music")).rejects.toThrow("曲库暂时不可用");
  });
});

describe("scan terminal-state refresh", () => {
  it.each(["completed", "failed"] as const)("refreshes only when a %s job is newly observed", (status) => {
    const running = scan("one", "running");
    const finished = scan("one", status);
    expect(scanJustFinished(undefined, finished)).toBe(false);
    expect(scanJustFinished(running, running)).toBe(false);
    expect(scanJustFinished(running, finished)).toBe(true);
    expect(scanJustFinished(finished, { ...finished })).toBe(false);
    expect(scanJustFinished(finished, scan("two", status))).toBe(true);
    expect(scanJustFinished(null, finished)).toBe(true);
    expect(scanJustFinished(finished, null)).toBe(false);
  });

  it("refreshes processed songs once after a server interruption, then accepts an incremental retry", () => {
    let previous: ScanJob | null = scan("interrupted", "running");
    const failed = { ...scan("interrupted", "failed"), totalFiles: 50, scannedFiles: 20, parsedFiles: 10, skippedFiles: 9, errorCount: 1, message: "服务已中断，请重新扫描" };
    const retry = { ...scan("retry", "running"), totalFiles: 50, scannedFiles: 20, parsedFiles: 0, skippedFiles: 20 };
    let refreshes = 0;
    for (const next of [failed, { ...failed }, { ...failed }, retry, { ...retry, status: "completed" as const }]) {
      if (scanJustFinished(previous, next)) refreshes += 1;
      previous = next;
    }
    expect(refreshes).toBe(2);
  });
});

describe("scan request options", () => {
  it("keeps the default scan body-free and sends explicit force/prune options only when requested", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json(scan("new", "running"))));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    await api.scan();
    await api.scan({ force: true }, signal);
    await api.scan({ prune: true }, signal);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/scan", "/api/scan", "/api/scan"]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", body: '{"force":true}', signal });
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "POST", body: '{"prune":true}', signal });
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get("Content-Type")).toBe("application/json");
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
