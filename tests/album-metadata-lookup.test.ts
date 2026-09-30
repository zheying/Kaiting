import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Album } from "../src/shared/types.js";
import type { AppConfig } from "../src/server/config.js";
import { albumMetadataQuery, createAlbumMetadataLookup } from "../src/server/album-metadata.js";
import { fetchMusicBrainzJson } from "../src/server/musicbrainz.js";
import { emptyMetadataDraft, metadataDraftReducer } from "../src/client/room/metadata-draft.js";

const id = "06594de4-cb73-4b2d-a27c-bdfae5235b17";
const anotherId = "06594de4-cb73-4b2d-a27c-bdfae5235b18";
const album: Album = { key: "album", title: "ゼノブレイド2 黄金の国イーラ オリジナル・サウンドトラック", artist: "光田康典 / ACE(工藤ともり、CHiCO)", year: null, genre: null, trackCount: 11, discCount: 1, duration: 2600, artworkTrackId: null };
function release(overrides: Record<string, unknown> = {}) {
  return { id, title: album.title, date: "2018-12-14", country: "JP", status: "Official", score: 100,
    "artist-credit": [{ name: "光田康典", joinphrase: " / ", artist: { name: "光田康典" } }, { name: "ACE(工藤ともり、CHiCO)", artist: { name: "ACE" } }],
    "track-count": 11, media: [{ "track-count": 11, format: "Digital Media" }], "release-group": { "secondary-types": ["Soundtrack"] }, ...overrides };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
function setup(releases: Record<string, unknown>[] = [release()], count = releases.length) {
  const store = new Map<string, unknown>();
  const db = { getMetadataCache: vi.fn((key: string) => store.get(key) ?? null), setMetadataCache: vi.fn((key: string, _provider: string, value: unknown) => { store.set(key, value); }) };
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const parsed = new URL(String(url));
    return json(parsed.searchParams.has("query") ? { releases, count } : releases.find((item) => parsed.pathname.endsWith(String(item.id))));
  });
  const config = { enableOnlineMetadata: true } as AppConfig;
  return { db, store, fetcher, config, lookup: createAlbumMetadataLookup(config, db, fetcher) };
}
async function finish<T>(promise: Promise<T>): Promise<T> {
  // Attach a rejection handler before moving fake timers past network deadlines.
  const result = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  const settled = await result;
  if ("error" in settled) throw settled.error;
  return settled.value;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("album online matching", () => {
  it("escapes tags as literal Lucene phrases", () => {
    expect(albumMetadataQuery('Album "A" (B) OR *:*')).toBe('release:"Album \\"A\\" \\(B\\) OR \\*\\:\\*"');
  });
  it("matches a unique edition, obtains genre, shares in-flight work and caches without modifying the album", async () => {
    const state = setup([release({ genres: [{ name: "video game music", count: 2 }] })]);
    const first = state.lookup(album), second = state.lookup(album);
    const [result, repeated] = await finish(Promise.all([first, second]));
    expect(result).toEqual(repeated);
    expect(result).toMatchObject({ recommendedId: id, partial: false, truncated: false, candidates: [{ year: 2018, genre: "游戏原声", trackCount: 11, sourceUrl: `https://musicbrainz.org/release/${id}` }] });
    expect(state.fetcher).toHaveBeenCalledTimes(2);
    expect(await state.lookup(album)).toEqual(result);
    expect(state.fetcher).toHaveBeenCalledTimes(2);
    expect(album).toMatchObject({ year: null, genre: null });
    vi.setSystemTime(Date.now() + 86400001);
    await finish(state.lookup(album));
    expect(state.fetcher).toHaveBeenCalledTimes(4);
  });
  it.each([
    { "artist-credit": [{ name: "別の作曲家" }] }, { "track-count": 10 },
    { media: [{ "track-count": 5 }, { "track-count": 6 }] }, { status: "Bootleg" }
  ])("does not automatically pick conflicting artist, count, discs or unofficial edition: %j", async (change) => {
    const { lookup } = setup([release(change)]);
    const result = await finish(lookup(album));
    expect(result.candidates).toHaveLength(1); expect(result.recommendedId).toBeNull();
  });
  it("preserves edition words and never trusts score 100 on its own", async () => {
    const { lookup, fetcher } = setup([release({ title: `${album.title} Remastered` }), release({ id: "https://foreign.invalid/", score: 100 })]);
    expect(await finish(lookup(album))).toMatchObject({ candidates: [], recommendedId: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("requires a choice for multiple versions and for truncated searches", async () => {
    const multiple = setup([release(), release({ id: anotherId, date: "2023-04-20", country: "US" })]);
    expect(await finish(multiple.lookup(album))).toMatchObject({ recommendedId: null, truncated: false });
    const truncated = setup([release()], 26);
    expect(await finish(truncated.lookup(album))).toMatchObject({ recommendedId: null, truncated: true });
  });
  it("does not infer a release year from the first-release-date or replace a known conflicting year", async () => {
    const missing = setup([release({ date: null, "release-group": { "first-release-date": "2010", "secondary-types": ["Soundtrack"] } })]);
    expect((await finish(missing.lookup(album))).candidates[0]).toMatchObject({ year: null, genre: "原声" });
    const existing = setup();
    expect(await finish(existing.lookup({ ...album, year: 2023 }))).toMatchObject({ recommendedId: null, candidates: [{ matches: { year: false } }] });
  });
  it("does not count unknown or Various Artists as an artist match", async () => {
    const { lookup } = setup([release({ "artist-credit": [{ name: "Various Artists" }] })]);
    expect((await finish(lookup({ ...album, artist: "Various Artists" }))).recommendedId).toBeNull();
  });
  it("expires empty results sooner and never caches connection errors or partial detail lookups", async () => {
    const empty = setup([]);
    await finish(empty.lookup(album)); vi.setSystemTime(Date.now() + 600001); await finish(empty.lookup(album));
    expect(empty.fetcher).toHaveBeenCalledTimes(2);
    const failed = setup(); failed.fetcher.mockRejectedValueOnce(new Error("network"));
    await expect(finish(failed.lookup(album))).rejects.toMatchObject({ statusCode: 502 });
    expect(failed.store.size).toBe(0);
    failed.fetcher.mockImplementation(async (url) => new URL(String(url)).searchParams.has("query") ? json({ releases: [release()], count: 1 }) : new Response("busy", { status: 503 }));
    expect(await finish(failed.lookup(album))).toMatchObject({ partial: true, candidates: [{ year: 2018, genre: "原声" }] });
    expect(failed.store.size).toBe(0);
  });
  it("does not access cached or remote data when disabled", async () => {
    const { lookup, config, fetcher, db } = setup(); config.enableOnlineMetadata = false;
    await expect(lookup(album)).rejects.toMatchObject({ statusCode: 409 });
    expect(fetcher).not.toHaveBeenCalled(); expect(db.getMetadataCache).not.toHaveBeenCalled();
  });
  it("does not write a late lookup cache after the server has closed", async () => {
    const state = setup(); let active = true;
    const lookup = createAlbumMetadataLookup(state.config, state.db, state.fetcher, () => active);
    const pending = lookup(album); active = false;
    await finish(pending); expect(state.db.setMetadataCache).not.toHaveBeenCalled();
  });
});

describe("MusicBrainz transport", () => {
  it("spaces concurrent requests by at least one second", async () => {
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => { starts.push(Date.now()); return json({}); });
    const url = "https://musicbrainz.org/ws/2/release/?fmt=json";
    await finish(Promise.all([fetchMusicBrainzJson(url, fetcher), fetchMusicBrainzJson(url, fetcher), fetchMusicBrainzJson(url, fetcher)]));
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000); expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(1000);
  });
  it("times out hung upstream requests", async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    await expect(finish(fetchMusicBrainzJson("https://musicbrainz.org/ws/2/release/", fetcher))).rejects.toMatchObject({ statusCode: 502, publicMessage: expect.stringContaining("超时") });
  });
  it("rejects oversized responses and never follows third-party URLs", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("x".repeat(1024 * 1024 + 1)));
    await expect(finish(fetchMusicBrainzJson("https://musicbrainz.org/ws/2/release/", fetcher))).rejects.toMatchObject({ statusCode: 502 });
    await expect(fetchMusicBrainzJson("https://foreign.invalid/", fetcher)).rejects.toThrow("Unexpected metadata URL");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
  });
});

describe("automatic form completion", () => {
  const values = { year: 2018, genre: "原声" };
  it("fills missing values and preserves existing information", () => {
    const current = metadataDraftReducer(emptyMetadataDraft, { type: "replace", values: { year: 2023, genre: null } });
    expect(metadataDraftReducer(current, { type: "fill", values, expectedEdits: current.edits })).toMatchObject({ year: "2023", genre: "原声" });
  });
  it("preserves edits made while a query is running, even after clearing a field", () => {
    const typed = metadataDraftReducer(emptyMetadataDraft, { type: "edit", field: "year", value: "2025" });
    const cleared = metadataDraftReducer(typed, { type: "edit", field: "year", value: "" });
    expect(metadataDraftReducer(cleared, { type: "fill", values, expectedEdits: emptyMetadataDraft.edits })).toMatchObject({ year: "", genre: "原声" });
  });
  it("switches generated fields together between editions, but preserves later manual input", () => {
    const first = metadataDraftReducer(emptyMetadataDraft, { type: "fill", values, expectedEdits: emptyMetadataDraft.edits });
    const edited = metadataDraftReducer(first, { type: "edit", field: "genre", value: "我的流派" });
    expect(metadataDraftReducer(edited, { type: "fill", values: { year: 2023, genre: "爵士" }, expectedEdits: edited.edits })).toMatchObject({ year: "2023", genre: "我的流派" });
    expect(metadataDraftReducer(first, { type: "fill", values: { year: 2023, genre: null }, expectedEdits: first.edits })).toMatchObject({ year: "2023", genre: "" });
  });
});
