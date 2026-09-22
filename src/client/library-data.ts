import type { Page } from "../shared/types.js";

const COLLECTION_CHANGED = "曲库内容已变化，请重新加载全部歌曲。";

/** Collect a complete queue, or reject instead of silently playing a partial list. */
export async function collectTrackPages<T extends { id: string }>(
  fetchPage: (offset: number, limit: number) => Promise<Page<T>>,
  signal?: AbortSignal,
  onProgress?: (loaded: number, total: number) => void
): Promise<T[]> {
  const items: T[] = [];
  const ids = new Set<string>();
  let total: number | undefined;
  let revision: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await fetchPage(items.length, 500);
    // Some transports may still resolve after cancellation.
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(page.total) || page.total < 0 || page.offset !== items.length
      || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.items.length > page.limit
      || page.offset + page.items.length > page.total) {
      throw new Error("歌曲列表返回不完整，请重试。");
    }
    if (total !== undefined && (total !== page.total || revision !== page.revision)) throw new Error(COLLECTION_CHANGED);
    total = page.total;
    revision = page.revision;
    if (page.items.length === 0 && items.length < total) throw new Error(COLLECTION_CHANGED);
    for (const item of page.items) {
      if (ids.has(item.id)) throw new Error(COLLECTION_CHANGED);
      ids.add(item.id);
      items.push(item);
    }
    onProgress?.(items.length, total);
  } while (items.length < total);
  return items;
}
