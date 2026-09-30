import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api.js";
import { scanJustFinished } from "../src/client/async-state.js";
import { scanCompletionNotice } from "../src/client/room/room-state.js";
import type { ScanJob } from "../src/shared/types.js";

function scan(id: string, status: ScanJob["status"]): ScanJob {
  return { id, status, startedAt: null, finishedAt: null, totalFiles: 1, scannedFiles: 1, parsedFiles: 1, skippedFiles: 0, force: false, prune: false, errorCount: 0, message: null };
}

afterEach(() => vi.unstubAllGlobals());

describe("client request lifecycle", () => {
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

describe("scan completion feedback", () => {
  it("does not announce historical results on initial load or on repeated snapshots", () => {
    for (const job of [scan("complete", "completed"), { ...scan("partial", "completed"), errorCount: 1 }]) {
      expect(scanCompletionNotice(undefined, job, 10)).toBe("");
      expect(scanCompletionNotice(job, { ...job }, 10)).toBe("");
    }
    expect(scanCompletionNotice(undefined, scan("empty", "completed"), 0)).toBe("");
  });

  it("announces each new completion once, including a fast rescan with no observed running snapshot", () => {
    let previous: ScanJob | null | undefined = undefined;
    const first = scan("first", "completed");
    const next = scan("next", "completed");
    const notices: string[] = [];
    for (const job of [first, scan("next", "running"), next, { ...next }, scan("fast", "completed")]) {
      const message = scanCompletionNotice(previous, job, 1);
      if (message) notices.push(message);
      previous = job;
    }
    expect(notices).toEqual(["扫描完成，音乐已经准备好", "扫描完成，音乐已经准备好"]);
    expect(scanCompletionNotice(null, first, 1)).toBe("扫描完成，音乐已经准备好");
  });

  it("distinguishes partial and empty results without reporting failures as success", () => {
    const running = scan("one", "running");
    const complete = scan("one", "completed");
    expect(scanCompletionNotice(running, { ...complete, errorCount: 1 }, 0)).toBe("扫描部分完成，可以查看失败详情");
    expect(scanCompletionNotice(running, complete, 0)).toBe("扫描完成，未发现可播放文件");
    expect(scanCompletionNotice(running, scan("one", "failed"), 1)).toBe("");
    expect(scanCompletionNotice(running, scan("one", "interrupted"), 1)).toBe("");
    expect(scanCompletionNotice(running, running, 1)).toBe("");
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
