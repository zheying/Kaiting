import { createHash } from "node:crypto";
import path from "node:path";

const lowerAscii = (value: unknown) => String(value).replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** Previous identities remain resolvable for saved album and player links. */
export function legacyAlbumKey(album: unknown, albumArtist: unknown, artist: unknown, filePath?: unknown): string {
  if (albumArtist == null && filePath != null) {
    const identity = [path.dirname(String(filePath)), lowerAscii(album ?? "未知专辑"), album == null ? lowerAscii(artist ?? "未知艺人") : null];
    return `folder:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  }
  return `${lowerAscii(album ?? "未知专辑")}::${lowerAscii(albumArtist ?? artist ?? "未知艺人")}`;
}

function discMarker(value: string): number | "bonus" | null {
  if (/^bonus\s+(?:disc|cd)$/i.test(value)) return "bonus";
  const match = /^(?:disc|cd)\s*0*([1-9]\d{0,2})$/i.exec(value);
  return match ? Number(match[1]) : null;
}

/** Only infer when the album suffix, disc directory and release directory agree.
 * These are indexed strings, not filesystem reads; explicit album-artist tags win.
 */
export function inferredRelease(album: unknown, albumArtist: unknown, filePath: unknown): { title: string; directory: string; disc: number | "bonus" } | null {
  if (albumArtist != null || typeof album !== "string" || typeof filePath !== "string") return null;
  const match = /^(.+?)\s+\[([^\[\]]+)\]$/.exec(album.trim());
  if (!match) return null;
  const disc = discMarker(match[2]);
  const folder = path.dirname(filePath);
  const directory = path.dirname(folder);
  const title = match[1].trim();
  if (disc == null || discMarker(path.basename(folder)) !== disc || lowerAscii(path.basename(directory)) !== lowerAscii(title)) return null;
  return { title, directory, disc };
}

export function albumKey(album: unknown, albumArtist: unknown, artist: unknown, filePath?: unknown): string {
  const release = inferredRelease(album, albumArtist, filePath);
  if (!release) return legacyAlbumKey(album, albumArtist, artist, filePath);
  return `multidisc:${createHash("sha256").update(JSON.stringify([release.directory, lowerAscii(release.title)])).digest("hex")}`;
}

export function albumTitle(album: unknown, albumArtist: unknown, filePath: unknown): string | null {
  return inferredRelease(album, albumArtist, filePath)?.title ?? (album == null ? null : String(album));
}

export function discNumber(album: unknown, albumArtist: unknown, filePath: unknown, taggedDisc: unknown): number | null {
  const release = inferredRelease(album, albumArtist, filePath);
  if (release) return release.disc === "bonus" ? null : release.disc;
  return taggedDisc == null ? null : Number(taggedDisc);
}

export function discSort(album: unknown, albumArtist: unknown, filePath: unknown, taggedDisc: unknown): number {
  if (inferredRelease(album, albumArtist, filePath)?.disc === "bonus") return 1_000_000;
  return discNumber(album, albumArtist, filePath, taggedDisc) ?? 1;
}
