import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAlbumKey, openDatabase, type DatabaseHandle, type UpsertTrack } from "../src/server/db.js";
import { legacyAlbumKey } from "../src/server/album-identity.js";
import { groupAlbumDiscs } from "../src/client/album-discs.js";

let directory: string;
let database: DatabaseHandle;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-album-grouping-"));
  database = openDatabase(path.join(directory, "library.sqlite"));
});

afterEach(() => {
  database.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function insert(id: string, overrides: Partial<UpsertTrack> = {}): UpsertTrack {
  const track: UpsertTrack = {
    id, path: path.join(directory, "music", "Soundtrack", `${id}.flac`), fileName: `${id}.flac`, title: `Song ${id}`,
    album: "Soundtrack", artist: "Composer A", albumArtist: null, genre: null, year: null,
    trackNo: 1, discNo: 1, duration: 60, bitrate: null, codec: "FLAC", container: "FLAC",
    lossless: true, formatGroup: "flac", artworkPath: null, lyricsPath: null, size: 100, mtimeMs: 1,
    ...overrides
  };
  database.upsertTrack(track);
  return track;
}

describe("conservative album grouping for missing album-artist tags", () => {
  it("combines corroborated disc titles and folders into a complete 180-track release without rewriting tags", () => {
    const counts = [20, 22, 24, 29, 23, 25, 13, 24];
    const originals: UpsertTrack[] = [];
    database.db.transaction(() => {
      for (let disc = counts.length; disc >= 1; disc--) {
        const marker = disc === 8 ? "Bonus Disc" : `Disc ${disc}`;
        for (let number = counts[disc - 1]; number >= 1; number--) {
          originals.push(insert(`${disc}-${number}`, {
            album: `Soundtrack [${marker}]`, artist: `Composer ${number % 3}`,
            path: path.join(directory, "music", "Soundtrack", marker, `${number}.flac`), trackNo: number, discNo: 1
          }));
        }
      }
    })();
    database.toggleFavorite("2-1", true);
    const playlist = database.createPlaylist("Across discs");
    database.addTrackToPlaylist(playlist.id, "7-13");
    database.addTrackToPlaylist(playlist.id, "8-1");
    const snapshot = () => ["tracks", "tracks_fts", "playlists", "playlist_tracks"].map((table) => database.db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();

    const [album] = database.listAlbums();
    expect(album).toMatchObject({ title: "Soundtrack", trackCount: 180, discCount: 8, artist: "多位艺人" });
    expect(database.summary()).toMatchObject({ albumCount: 1, trackCount: 180, favoriteCount: 1 });
    const detail = database.getAlbum(album.key)!;
    const ids = counts.flatMap((count, index) => Array.from({ length: count }, (_, n) => `${index + 1}-${n + 1}`));
    expect(detail.tracks.map((track) => track.id)).toEqual(ids);
    expect(detail.tracks.every((track) => track.albumKey === album.key && track.album === "Soundtrack")).toBe(true);
    expect(database.getTrack("7-1")).toMatchObject({ discNo: 7, discTitle: null });
    expect(database.getTrack("8-1")).toMatchObject({ discNo: null, discTitle: "附赠碟" });
    expect(database.listTracks({ limit: 200 }).map((track) => track.id)).toEqual(ids);
    expect(groupAlbumDiscs(detail.tracks).map((group) => [group.title, group.tracks.length])).toEqual(counts.map((count, index) => [index === 7 ? "附赠碟" : `第 ${index + 1} 碟`, count]));
    expect(database.pageAlbums({ q: "[Disc 7]" }).items).toEqual([album]);
    expect(database.search("Composer 2").albums).toEqual([album]);
    expect(database.getArtist("Composer 2")?.albums).toEqual([album]);
    for (const marker of ["1-1", "7-1", "8-1"]) {
      const raw = originals.find((track) => track.id === marker)!;
      expect(database.getAlbum(legacyAlbumKey(raw.album, null, raw.artist, raw.path))?.album.key).toBe(album.key);
      expect(database.getAlbum(makeAlbumKey(raw.album, null, raw.artist))?.tracks).toHaveLength(180);
    }
    expect(database.getPlaylist(playlist.id)?.tracks.map((track) => track.id)).toEqual(["7-13", "8-1"]);
    expect(snapshot()).toEqual(before);
    database.db.close();
    database = openDatabase(path.join(directory, "library.sqlite"));
    expect(database.getAlbum(album.key)).toEqual(detail);
    expect(snapshot()).toEqual(before);
  });

  it("sorts numbered discs numerically before bonus and keeps differently located releases and editions separate", () => {
    for (const marker of ["Disc 10", "Bonus Disc", "CD 2", "Disc 1"]) {
      insert(marker, { album: `Soundtrack [${marker}]`, path: path.join(directory, "music", "Soundtrack", marker, "song.flac") });
    }
    const album = database.listAlbums()[0];
    expect(database.getAlbum(album.key)?.tracks.map((track) => track.id)).toEqual(["Disc 1", "CD 2", "Disc 10", "Bonus Disc"]);
    insert("different-location", { album: "Soundtrack [Disc 1]", path: path.join(directory, "other", "Soundtrack", "Disc 1", "song.flac") });
    insert("plus", { album: "Soundtrack Plus [Disc 1]", path: path.join(directory, "music", "Soundtrack Plus", "Disc 1", "song.flac") });
    expect(database.summary().albumCount).toBe(3);
    expect(database.getAlbum(makeAlbumKey("Soundtrack [Disc 1]", null, "Composer A"))).toBeNull();
    expect(database.getAlbum(album.key)?.tracks).toHaveLength(4);
  });

  it.each([
    ["Soundtrack [Disc 1]", "Soundtrack", "Disc 2", null],
    ["Soundtrack [Disc 1]", "Different release", "Disc 1", null],
    ["Soundtrack [Disc 0]", "Soundtrack", "Disc 0", null],
    ["Soundtrack [Deluxe]", "Soundtrack", "Deluxe", null],
    ["Soundtrack [Disc 1]", "Soundtrack", "Disc 1", "Album Artist"]
  ])("does not infer a multi-disc identity from conflicting or explicit metadata: %s / %s / %s", (title, root, folder, albumArtist) => {
    const raw = insert("one", { album: title, albumArtist, path: path.join(directory, "music", root!, folder!, "one.flac") });
    expect(database.getTrack("one")?.album).toBe(title);
    expect(database.getTrack("one")?.albumKey).toBe(legacyAlbumKey(title, albumArtist, raw.artist, raw.path));
  });

  it("keeps a 98-track multi-composer soundtrack complete across album, track and artist queries", () => {
    database.db.transaction(() => {
      for (let index = 97; index >= 0; index--) {
        insert(String(index).padStart(3, "0"), {
          artist: `Composer ${index % 6}`, discNo: Math.floor(index / 20) + 1, trackNo: index % 20 + 1
        });
      }
    })();

    const albums = database.pageAlbums({ limit: 1 });
    expect(albums.total).toBe(1);
    expect(albums.items[0]).toMatchObject({ title: "Soundtrack", artist: "多位艺人", trackCount: 98, duration: 5880 });
    const key = albums.items[0].key;
    const detail = database.getAlbum(key)!;
    expect(detail.tracks.map((track) => track.id)).toEqual(Array.from({ length: 98 }, (_, index) => String(index).padStart(3, "0")));
    expect(new Set(detail.tracks.map((track) => track.albumKey))).toEqual(new Set([key]));
    expect(database.getTrack("000")?.albumKey).toBe(key);
    expect(database.pageTracks({ offset: 80, limit: 20 }).items.every((track) => track.albumKey === key)).toBe(true);
    expect(database.summary()).toMatchObject({ trackCount: 98, albumCount: 1, artistCount: 6 });
    expect(database.pageAlbums({ offset: 1 }).items).toEqual([]);

    for (let index = 0; index < 6; index++) {
      const artist = database.getArtist(`Composer ${index}`)!;
      expect(artist.artist.albumCount).toBe(1);
      expect(artist.artist.trackCount).toBe(artist.tracks.length);
      expect(artist.albums).toEqual(albums.items);
      expect(artist.tracks.every((track) => track.albumKey === key)).toBe(true);
      expect(database.pageAlbums({ q: `Composer ${index}` }).items).toEqual(albums.items);
    }
  });

  it("does not merge same-title releases in different directories or with different edition titles", () => {
    for (const release of ["Original", "Remaster"]) {
      for (const composer of ["A", "B"]) {
        insert(`${release}-${composer}`, { path: path.join(directory, "music", release, `${composer}.flac`), artist: `Composer ${composer}` });
      }
    }
    insert("deluxe", { album: "Soundtrack [Deluxe]", path: path.join(directory, "music", "Original", "deluxe.flac") });
    const albums = database.listAlbums();
    expect(albums).toHaveLength(3);
    expect(new Set(albums.map((album) => album.key)).size).toBe(3);
    expect(albums.map((album) => album.trackCount).sort()).toEqual([1, 2, 2]);
    expect(database.getArtist("Composer A")?.artist.albumCount).toBe(3);
    expect(database.getArtist("Composer A")?.albums).toHaveLength(3);
    expect(database.summary().albumCount).toBe(3);
    for (const album of albums) expect(database.getAlbum(album.key)?.tracks).toHaveLength(album.trackCount);
  });

  it("does not infer that untagged CD or bonus directories belong to one release", () => {
    for (const folder of ["CD1", "CD2", "Bonus Disc"]) {
      insert(folder, { path: path.join(directory, "music", "Soundtrack", folder, "track.flac") });
    }
    expect(database.pageAlbums().total).toBe(3);
  });

  it("preserves explicit album-artist identities and complete multi-disc releases", () => {
    for (const folder of ["CD1", "CD2", "Disc 1", "Disc 2"]) {
      insert(folder, {
        path: path.join(directory, "music", "Soundtrack", folder, "track.flac"),
        artist: `Performer ${folder}`, albumArtist: "Album Artist"
      });
    }
    insert("other-edition", { album: "Soundtrack [Deluxe]", albumArtist: "Album Artist" });
    insert("different-artist", { albumArtist: "Another Album Artist" });
    const key = makeAlbumKey("Soundtrack", "Album Artist", null);
    expect(database.getAlbum(key)?.tracks).toHaveLength(4);
    expect(database.getAlbum(key)?.album).toMatchObject({ key, artist: "Album Artist", trackCount: 4 });
    expect(database.summary().albumCount).toBe(3);
    expect(database.getArtist("Album Artist")?.artist.albumCount).toBe(2);
  });

  it("resolves old per-composer links to the whole unique release and rejects ambiguous old links", () => {
    const first = insert("one");
    insert("two", { artist: "Composer B" });
    const oldKey = makeAlbumKey(first.album, first.albumArtist, first.artist);
    const newKey = database.getTrack(first.id)!.albumKey!;
    expect(database.getAlbum(oldKey)?.album.key).toBe(newKey);
    expect(database.getAlbum(oldKey)?.tracks).toHaveLength(2);

    insert("remaster", { path: path.join(directory, "music", "Remaster", "track.flac") });
    expect(database.getAlbum(oldKey)).toBeNull();
    expect(database.getAlbum(newKey)?.tracks).toHaveLength(2);
    expect(database.getAlbum("unknown::artist")).toBeNull();
  });

  it("keeps canonical explicit keys usable when an untagged release has the same old identity", () => {
    insert("tagged", { albumArtist: "Composer A" });
    insert("untagged");
    expect(database.listAlbums()).toHaveLength(2);
    for (const album of database.listAlbums()) {
      expect(database.getAlbum(album.key)?.album).toEqual(album);
      expect(database.getAlbum(album.key)?.tracks).toHaveLength(1);
    }
  });

  it("matches all contributing artists literally without changing the displayed compilation artist", () => {
    insert("one", { artist: "A Composer" });
    insert("two", { artist: "ZZ 100%_ÉTÉ 夜曲" });
    insert("other", { album: "Unrelated", artist: "Other" });
    for (const q of ["100%", "_", "éTé", "夜曲", "zz", "多位艺人"]) {
      const page = database.pageAlbums({ q, limit: 1 });
      expect(page.total, q).toBe(1);
      expect(page.items[0]).toMatchObject({ title: "Soundtrack", artist: "多位艺人", trackCount: 2 });
      expect(database.pageAlbums({ q, limit: 1, offset: 1 })).toMatchObject({ total: 1, items: [] });
      expect(database.search(q).albums).toEqual(page.items);
    }
    expect(database.pageAlbums({ q: "100x" }).total).toBe(0);
  });

  it("uses consistent ASCII title folding and preserves case-sensitive directory identities", () => {
    insert("one", { album: "ÉTÉ / 夜曲", path: path.join(directory, "music", "Release", "one.flac") });
    insert("two", { album: "ÉtÉ / 夜曲", artist: "Composer B", path: path.join(directory, "music", "Release", "two.flac") });
    insert("other", { album: "ÉTÉ / 夜曲", path: path.join(directory, "music", "release", "other.flac") });
    expect(database.pageAlbums().total).toBe(2);
    const key = database.getTrack("one")!.albumKey!;
    expect(database.getTrack("two")?.albumKey).toBe(key);
    expect(database.getTrack("other")?.albumKey).not.toBe(key);
    expect(database.getAlbum(key)?.tracks).toHaveLength(2);
    expect(database.getAlbum(makeAlbumKey("ÉTÉ / 夜曲", null, "Composer B"))?.album.key).toBe(key);
  });

  it("does not invent a shared album for unrelated tracks with no album tag", () => {
    insert("one", { album: null, artist: "Composer A" });
    insert("two", { album: null, artist: "Composer B" });
    expect(database.pageAlbums().total).toBe(2);
    expect(database.getAlbum(makeAlbumKey(null, null, "Composer A"))?.tracks.map((track) => track.id)).toEqual(["one"]);
  });

  it("does not rewrite indexed metadata, FTS rows, favorites or playlist members and is stable after reopening", () => {
    insert("one");
    insert("two", { artist: "Composer B" });
    database.toggleFavorite("one", true);
    const playlist = database.createPlaylist("Fixture");
    database.addTrackToPlaylist(playlist.id, "two");
    database.addTrackToPlaylist(playlist.id, "one");

    const indexed = database.db.prepare("SELECT rowid, * FROM tracks ORDER BY id").all();
    const fts = database.db.prepare("SELECT rowid, * FROM tracks_fts ORDER BY id").all();
    const members = database.db.prepare("SELECT * FROM playlist_tracks ORDER BY position").all();
    const albums = database.listAlbums();
    const previousPlaylist = database.getPlaylist(playlist.id);
    database.db.close();
    database = openDatabase(path.join(directory, "library.sqlite"));

    expect(database.listAlbums()).toEqual(albums);
    expect(database.db.prepare("SELECT rowid, * FROM tracks ORDER BY id").all()).toEqual(indexed);
    expect(database.db.prepare("SELECT rowid, * FROM tracks_fts ORDER BY id").all()).toEqual(fts);
    expect(database.db.prepare("SELECT * FROM playlist_tracks ORDER BY position").all()).toEqual(members);
    expect(database.getPlaylist(playlist.id)).toEqual(previousPlaylist);
    expect(database.listTracks({ favorite: true }).map((track) => track.id)).toEqual(["one"]);
    expect(database.getPlaylist(playlist.id)?.tracks.every((track) => track.albumKey === albums[0].key)).toBe(true);
    expect(database.db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(database.db.pragma("foreign_key_check")).toEqual([]);
  });
});
