import type { Playlist, Track } from "../shared/types.js";

export function movePlaylistTrack(tracks: Track[], from: number, to: number): Track[] {
  if (from < 0 || to < 0 || from >= tracks.length || to >= tracks.length || from === to) return tracks;
  const next = [...tracks];
  const [track] = next.splice(from, 1);
  next.splice(to, 0, track);
  return next;
}

export function createPlaylistMutationLock() {
  const pending = new Set<string>();
  return async function run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (pending.has(id)) throw new Error("此歌单正在更新，请稍候再试。");
    pending.add(id);
    try { return await operation(); } finally { pending.delete(id); }
  };
}

export function createTrackPlaylistAdder(
  create: (name: string) => Promise<Playlist>,
  add: (playlistId: string, trackId: string) => Promise<void>,
  onCreated: (playlist: Playlist) => void
) {
  const created = new Map<string, Playlist>();
  const pending = new Map<string, Promise<void>>();
  return function createAndAdd(name: string, trackId: string): Promise<void> {
    const normalized = name.trim();
    if (!normalized) return Promise.reject(new Error("请输入歌单名称"));
    const key = JSON.stringify([normalized, trackId]);
    const existing = pending.get(key);
    if (existing) return existing;
    const operation = (async () => {
      let playlist = created.get(key);
      if (!playlist) {
        playlist = await create(normalized);
        created.set(key, playlist);
        onCreated(playlist);
      }
      try {
        await add(playlist.id, trackId);
        created.delete(key);
      } catch (error) {
        throw new Error(`歌单「${playlist.name}」已创建，添加歌曲失败：${error instanceof Error ? error.message : "请重试"}`);
      }
    })().finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  };
}
