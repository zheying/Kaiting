import type { ArtworkSize } from "../shared/artwork.js";

export function isLibraryArtwork(src: string | undefined): src is string {
  return Boolean(src && /^\/api\/tracks\/[^/?#]+\/artwork(?:\?|$)/.test(src));
}

export function sizedArtworkUrl(src: string, size: ArtworkSize): string {
  if (!isLibraryArtwork(src)) return src;
  const [pathname, query] = src.split("?");
  const params = new URLSearchParams(query);
  params.set("size", String(size));
  return `${pathname}?${params}`;
}
