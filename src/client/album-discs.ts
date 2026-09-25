import type { Track } from "../shared/types.js";

export function groupAlbumDiscs(tracks: Track[]): { key: string; title: string; tracks: Track[] }[] {
  const groups = new Map<string, { key: string; title: string; tracks: Track[] }>();
  for (const track of tracks) {
    const key = track.discTitle ? `title:${track.discTitle}` : `disc:${track.discNo ?? 1}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, title: track.discTitle ?? `第 ${track.discNo ?? 1} 碟`, tracks: [] };
      groups.set(key, group);
    }
    group.tracks.push(track);
  }
  return [...groups.values()];
}
