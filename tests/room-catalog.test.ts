import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestId } from "../src/client/request-id.js";
import { buildAlbumMap, buildArtistIndex, loadAlbums, loadPlaylists, mapAlbum, mapTrack, mergePlaylistResults, type Playlist } from "../src/client/room/catalog-data.js";
import type { Album, Track } from "../src/shared/types.js";

afterEach(() => vi.unstubAllGlobals());

function track(id: string, artist: string | null, albumKey = "album-one"): Track {
  return { id, artist, albumKey, path: `${id}.mp3`, fileName: `${id}.mp3`, title: id, album: "Shared album", albumArtist: "Various artists", genre: null, year: 2020, trackNo: 1, discNo: 1, duration: 60, bitrate: 320000, codec: "mp3", container: "mp3", lossless: false, formatGroup: "mp3", hasArtwork: true, hasLyrics: false, favorite: false, addedAt: "", updatedAt: "" };
}
const album: Album = { key: "album-one", title: "Shared album", artist: "Various artists", year: 2020, trackCount: 2, duration: 120, artworkTrackId: "one" };

describe("LAN HTTP playlist request IDs", () => {
  it("generates distinct server-compatible keys without crypto.randomUUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const ids = Array.from({ length: 100 }, () => createRequestId());
    expect(new Set(ids).size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });
  it("uses the native generator when available and provides a readable unsupported-browser failure", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "native-request-id" });
    expect(createRequestId()).toBe("native-request-id");
    vi.stubGlobal("crypto", undefined);
    expect(() => createRequestId()).toThrow("浏览器暂时无法创建请求");
  });
});

describe("partial catalog failures", () => {
  it("uses the album endpoint's metadata even before tracks refresh and never renders an empty genre", () => {
    const songs = [mapTrack({ ...track("one", "ACE+"), genre: "旧流派" })];
    expect(mapAlbum({ ...album, year: 2018, genre: "游戏原声" }, songs)).toMatchObject({ year: 2018, genre: "游戏原声" });
    expect(mapAlbum({ ...album, genre: null }, songs).genre).toBe("未分类");
    expect(mapAlbum({ ...album, genre: "   " }, songs).genre).toBe("未分类");
    expect(mapAlbum(album, songs).genre).toBe("旧流派");
  });
  it("retains a failed playlist's identity while loading the other playlist", async () => {
    const listed = [{ id: "broken", name: "保留名称", description: null }, { id: "good", name: "可用歌单", description: "已收藏" }];
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/playlists") return Response.json(listed);
      if (path === "/api/playlists/broken") return Response.json({ error: "歌单暂时不可读" }, { status: 503 });
      if (path === "/api/playlists/good") return Response.json({ playlist: listed[1], tracks: [track("one", "ACE+")], revision: "revision-good" });
      throw new Error(`Unexpected request: ${path}`);
    }));
    const result = await loadPlaylists(new AbortController().signal);
    expect(result).toEqual([
      { id: "broken", name: "保留名称", description: "喜欢的音乐，慢慢收集。", trackIds: [], revision: "", detailError: "歌单暂时不可读" },
      { id: "good", name: "可用歌单", description: "已收藏", trackIds: ["one"], revision: "revision-good" }
    ]);
    const cached: Playlist = { id: "broken", name: "旧名称", description: "", trackIds: ["old-song"], revision: "last-good" };
    expect(mergePlaylistResults([cached], result)[0]).toMatchObject({ name: "保留名称", trackIds: ["old-song"], revision: "last-good", detailError: "歌单暂时不可读" });
    const repaired = { ...cached, trackIds: ["new-song"], revision: "repaired" };
    expect(mergePlaylistResults(result, [repaired])).toEqual([repaired]);
  });
  it("does not return a misleading empty collection on list failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "目录接口暂时不可用" }, { status: 503 })));
    await expect(loadPlaylists(new AbortController().signal)).rejects.toThrow("目录接口暂时不可用");
    await expect(loadAlbums(new AbortController().signal)).rejects.toThrow("目录接口暂时不可用");
  });
  it("rejects an aborted batch even if its transport returns a late result", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/playlists") return Response.json([{ id: "old", name: "旧歌单" }]);
      controller.abort();
      return Response.json({ playlist: { id: "old", name: "旧歌单" }, tracks: [], revision: "old" });
    }));
    await expect(loadPlaylists(controller.signal)).rejects.toThrow();
  });
  it("retains song-row and player artwork when albums are unavailable", () => {
    const songs = [mapTrack(track("one", "ACE+"))];
    const map = buildAlbumMap([], songs);
    expect(map.get("album-one")).toMatchObject({ id: "album-one", name: "Shared album", cover: "/api/tracks/one/artwork" });
    const actual = mapAlbum({ ...album, title: "Canonical album" }, songs);
    expect(buildAlbumMap([actual], songs).get("album-one")).toBe(actual);
  });
});

describe("shared artist index", () => {
  it("includes track-only artists, deduplicates album membership, and agrees with detail membership", () => {
    const songs = [track("one", "ACE+"), track("two", "ACE+"), track("three", "AC/DC", "album-two")].map(mapTrack);
    const albums = [mapAlbum(album, songs)];
    const index = buildArtistIndex(albums, songs);
    const ace = index.find((artist) => artist.name === "ACE+")!;
    expect(ace.trackIds).toEqual(new Set(["one", "two"]));
    expect(ace.albumIds).toEqual(new Set(["album-one"]));
    expect(index.map((artist) => artist.name)).toContain("AC/DC");
    expect(index.map((artist) => artist.name)).not.toContain("AC");
    expect(index.find((artist) => artist.name === "Various artists")?.trackIds).toEqual(new Set(["one", "two", "three"]));
    expect(buildArtistIndex([], songs).find((artist) => artist.name === "ACE+")).toEqual(ace);
  });
  it("does not count a song twice when its track and album artist are identical", () => {
    const songs = [mapTrack({ ...track("one", "ACE+"), albumArtist: "ACE+" })];
    const albums = [mapAlbum({ ...album, artist: "ACE+" }, songs)];
    expect(buildArtistIndex(albums, songs)).toEqual([{ name: "ACE+", albumIds: new Set(["album-one"]), trackIds: new Set(["one"]) }]);
  });
});
