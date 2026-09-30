// A finite set keeps both disk usage and resize work independent of arbitrary
// client dimensions. Values are physical pixels, not CSS pixels.
export const artworkSizes = [64, 128, 256, 512, 1024, 1600] as const;
export type ArtworkSize = typeof artworkSizes[number];

export function artworkSizeFor(pixels: number): ArtworkSize {
  return artworkSizes.find((size) => size >= pixels) ?? artworkSizes[artworkSizes.length - 1];
}
