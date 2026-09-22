import { describe, expect, it, vi } from "vitest";
import { createPlaylistMutationLock, createTrackPlaylistAdder, movePlaylistTrack } from "../src/client/playlist-state.js";
import type { Playlist, Track } from "../src/shared/types.js";

const playlist = { id: "new-list", name: "日常" } as Playlist;

describe("playlist editing state", () => {
  it("reorders a draft without changing the original playback snapshot", () => {
    const original = [{ id: "a" }, { id: "b" }, { id: "c" }] as Track[];
    expect(movePlaylistTrack(original, 2, 0).map((track) => track.id)).toEqual(["c", "a", "b"]);
    expect(original.map((track) => track.id)).toEqual(["a", "b", "c"]);
    expect(movePlaylistTrack(original, 0, -1)).toBe(original);
  });

  it("rejects overlapping edits to one playlist but allows another playlist and releases failed locks", async () => {
    const run = createPlaylistMutationLock();
    let reject!: (error: Error) => void;
    const first = run("one", () => new Promise((_, fail) => { reject = fail; }));
    const firstResult = expect(first).rejects.toThrow("failed");
    await expect(run("one", async () => "duplicate")).rejects.toThrow("正在更新");
    await expect(run("two", async () => "other")).resolves.toBe("other");
    reject(new Error("failed"));
    await firstResult;
    await expect(run("one", async () => "retried")).resolves.toBe("retried");
  });

  it("retries adding to an already created playlist instead of creating a duplicate", async () => {
    const create = vi.fn().mockResolvedValue(playlist);
    const add = vi.fn().mockRejectedValueOnce(new Error("离线")).mockResolvedValueOnce(undefined);
    const onCreated = vi.fn();
    const createAndAdd = createTrackPlaylistAdder(create, add, onCreated);
    await expect(createAndAdd(" 日常 ", "track")).rejects.toThrow("已创建，添加歌曲失败");
    await expect(createAndAdd("日常", "track")).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(add.mock.calls).toEqual([["new-list", "track"], ["new-list", "track"]]);
  });

  it("does not create more empty playlists when adding a disappeared track returns 404", async () => {
    const create = vi.fn().mockResolvedValue(playlist);
    const add = vi.fn().mockRejectedValue(Object.assign(new Error("歌曲不存在"), { status: 404 }));
    const createAndAdd = createTrackPlaylistAdder(create, add, vi.fn());
    await expect(createAndAdd("日常", "missing-track")).rejects.toThrow("歌曲不存在");
    await expect(createAndAdd("日常", "missing-track")).rejects.toThrow("歌曲不存在");
    expect(create).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("coalesces double clicks while playlist creation is pending", async () => {
    let finish!: (value: Playlist) => void;
    const create = vi.fn().mockImplementation(() => new Promise<Playlist>((resolve) => { finish = resolve; }));
    const add = vi.fn().mockResolvedValue(undefined);
    const createAndAdd = createTrackPlaylistAdder(create, add, vi.fn());
    const first = createAndAdd("日常", "track");
    const second = createAndAdd("日常", "track");
    expect(second).toBe(first);
    finish(playlist);
    await first;
    expect(create).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });
});
