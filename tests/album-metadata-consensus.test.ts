import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseHandle, type UpsertTrack } from "../src/server/db.js";
import { createAlbumEnricher } from "../src/server/album-enrichment.js";
import { createAlbumMetadataLookup } from "../src/server/album-metadata.js";
import type { AppConfig } from "../src/server/config.js";
import type { Scanner } from "../src/server/scanner.js";

const title = "夜曲 Original Soundtrack";
const artist = "测试作曲家";
const names = ["第一幕 晨光", "第二幕 午后", "第三幕 黄昏", "终曲 夜色"];
const id = (n: number) => `${String(n).padStart(8, "0")}-cb73-4b2d-a27c-bdfae5235b17`;
let root: string, db: DatabaseHandle, worker: ReturnType<typeof createAlbumEnricher> | undefined;
const config = { enableOnlineMetadata: true, autoCompleteAlbumMetadata: true } as AppConfig;
function local(index: number, overrides: Partial<UpsertTrack> = {}): UpsertTrack {
  return { id: String(index), path: path.join(root, `song-${index}.flac`), fileName: `song-${index}.flac`, title: names[index],
    album: title, albumArtist: artist, artist, year: null, genre: null, trackNo: index + 1, discNo: 1,
    duration: 60 + index, bitrate: 800000, codec: "FLAC", container: "FLAC", lossless: true, formatGroup: "flac",
    artworkPath: null, lyricsPath: null, size: 1, mtimeMs: 1, ...overrides };
}
function release(n = 1, overrides: Record<string, unknown> = {}) {
  return { id: id(n), title, status: "Official", date: "2023-08-02", "track-count": 4,
    "artist-credit": [{ name: artist, artist: { name: artist } }],
    media: [{ position: 1, format: "Digital Media", "track-count": 4, tracks: names.map((name, i) => ({ title: name, length: (60 + i) * 1000 })) }],
    genres: [{ name: "soundtrack", count: 2 }], ...overrides };
}
function arrange(releases = [release()], count = releases.length) {
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const u = new URL(String(url));
    return Response.json(u.searchParams.has("query") ? { releases, count } : releases.find((item) => u.pathname.endsWith(item.id)));
  });
  const lookup = createAlbumMetadataLookup(config, db, fetcher);
  worker = createAlbumEnricher(config, db, { isRunning: () => false } as Scanner, lookup);
  return { lookup, fetcher };
}
async function run() { worker!.trigger(); await vi.runAllTimersAsync(); await worker!.whenIdle(); }
const metadata = () => db.getAlbumMetadata(db.listAlbums()[0].key)!;

beforeEach(() => {
  vi.useFakeTimers();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "metadata-consensus-")));
  db = openDatabase(path.join(root, "library.sqlite")); db.setLibraryRoot(root);
  for (let i = 0; i < names.length; i++) db.upsertTrack(local(i));
});
afterEach(() => { worker?.stop(); worker = undefined; db.db.close(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });

describe("field consensus through the lookup, background queue and SQLite", () => {
  it("saves agreeing fields across editions and retains all supporting sources", async () => {
    arrange([release(1), release(2, { date: "2023-07-29" })]); await run();
    expect(metadata()).toMatchObject({ album: { year: 2023, genre: "原声" }, automatic: {
      sources: { year: [1, 2].map((n) => `https://musicbrainz.org/release/${id(n)}`), genre: [1, 2].map((n) => `https://musicbrainz.org/release/${id(n)}`) }
    } });
  });
  it.each([
    [{ date: "2024" }, { year: null, genre: "原声" }],
    [{ genres: [{ name: "jazz", count: 2 }] }, { year: 2023, genre: null }],
    [{ date: null, genres: [] }, { year: 2023, genre: "原声" }]
  ])("only fills fields supported without contradictory known values: %j", async (change, expected) => {
    arrange([release(1), release(2, change)]); await run();
    expect(metadata().album).toMatchObject(expected);
  });
  it("checks more than five candidates instead of treating an arbitrary display limit as ambiguity", async () => {
    arrange(Array.from({ length: 8 }, (_, i) => release(i + 1))); await run();
    expect(metadata().album).toMatchObject({ year: 2023, genre: "原声" });
  });
  it.each(["Various Artists", "多位艺人"])("uses complete track titles and durations to verify generic credits: %s", async (credit) => {
    for (let i = 0; i < names.length; i++) db.upsertTrack(local(i, { albumArtist: credit }));
    arrange([release(1, { "artist-credit": [{ name: "Various Artists" }] })]); await run();
    expect(metadata().album).toMatchObject({ year: 2023, genre: "原声" });
  });
  it("verifies the same music even when local discs are split differently", async () => {
    for (let i = 0; i < names.length; i++) db.upsertTrack(local(i, { discNo: i < 2 ? 1 : 2 }));
    arrange(); await run(); expect(metadata().album).toMatchObject({ year: 2023, genre: "原声" });
  });
  it("fills genre when the matching release has no year and keeps the native year", async () => {
    for (let i = 0; i < names.length; i++) db.upsertTrack(local(i, { year: 2023 }));
    arrange([release(1, { date: null })]); await run();
    expect(metadata()).toMatchObject({ album: { year: 2023, genre: "原声" }, automatic: { year: null, genre: "原声" } });
  });
  it.each(["prefix", "suffix"])("verifies translated recording titles with an upstream-provided %s", async (kind) => {
    const decorated = (name: string) => kind === "prefix" ? `发行标记: ${name}` : `${name} (OST Ver.)`;
    for (let i = 0; i < names.length; i++) db.upsertTrack(local(i, { title: decorated(names[i]), albumArtist: "Various Artists" }));
    arrange([release(1, { "artist-credit": [{ name: "Various Artists" }], media: [{ "track-count": 4, tracks: names.map((name, i) => ({ title: decorated(`English title ${i}`), length: (60 + i) * 1000, recording: { title: name } })) }] })]);
    await run(); expect(metadata().album).toMatchObject({ year: 2023, genre: "原声" });
  });
  it("recognizes a uniform short album qualifier but does not strip unrelated version prefixes", async () => {
    const orchestral = `${title} Orchestral Arrangement Album`;
    for (let i = 0; i < names.length; i++) db.upsertTrack(local(i, { album: orchestral, title: `Orc: ${names[i]}`, albumArtist: "Various Artists" }));
    arrange([release(1, { title: orchestral })]); await run(); expect(metadata().album.year).toBe(2023); worker!.stop();
    for (let i = 0; i < names.length; i++) db.upsertTrack(local(i, { title: `Live: ${names[i]}`, albumArtist: "Various Artists" }));
    arrange(); await run(); expect(metadata().automatic).toBeNull();
  });
  it.each([
    { title: `${title} Remastered` }, { status: "Bootleg" }, { "track-count": 5 },
    { "artist-credit": [{ name: "另一个作曲家" }] },
    { media: [{ "track-count": 4, tracks: names.map((name, i) => ({ title: i === 0 ? "不同的第一首" : name, length: (60 + i) * 1000 })) }] },
    { media: [{ "track-count": 4, tracks: names.map((name) => ({ title: name, length: 120000 })) }] },
    { media: [{ "track-count": 4, tracks: names.map((name, i) => ({ title: i === 0 ? names[1] : name, length: (60 + i) * 1000 })) }] }
  ])("rejects conflicting identity, bonus editions and track evidence: %j", async (change) => {
    arrange([release(1, change)]); await run(); expect(metadata().automatic).toBeNull();
  });
  it("requires duration and full title evidence for generic artists instead of accepting common titles alone", async () => {
    for (let i = 0; i < names.length; i++) db.upsertTrack(local(i, { albumArtist: "Various Artists" }));
    arrange([release(1, { "artist-credit": [{ name: "Various Artists" }], media: [{ "track-count": 4, tracks: names.map((name) => ({ title: name })) }] })]);
    await run(); expect(metadata().automatic).toBeNull();
  });
  it("does not derive consensus from incomplete searches or over-budget sets", async () => {
    arrange([release()], 101); await run(); expect(metadata().automatic).toBeNull(); worker!.stop();
    arrange(Array.from({ length: 13 }, (_, i) => release(i + 1))); await run(); expect(metadata().automatic).toBeNull();
  });
  it("invalidates evidence when titles change even if the album name, count and durations stay the same", async () => {
    const { lookup, fetcher } = arrange();
    const first = lookup(db.listAlbums()[0]); await vi.runAllTimersAsync(); await first;
    const requests = fetcher.mock.calls.length;
    db.upsertTrack(local(0, { title: "另一个版本的序曲" }));
    await run(); expect(fetcher.mock.calls.length).toBeGreaterThan(requests); expect(metadata().automatic).toBeNull();
  });
  it("retains the first field and its sources when a later lookup can fill the other field", async () => {
    arrange([release(1), release(2, { date: "2024" })]); await run();
    expect(metadata().album).toMatchObject({ year: null, genre: "原声" }); worker!.stop();
    db.db.prepare("DELETE FROM metadata_cache").run();
    arrange([release(3)]); await run();
    expect(metadata()).toMatchObject({ album: { year: 2023, genre: "原声" }, automatic: { sources: {
      year: [`https://musicbrainz.org/release/${id(3)}`], genre: [1, 2].map((n) => `https://musicbrainz.org/release/${id(n)}`)
    } } });
  });
});
