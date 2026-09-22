import { useEffect, useRef, useState } from "react";
import { createLatestRequest } from "./async-state.js";
import type { Page } from "../shared/types.js";

export async function loadValidPage<T>(
  load: (offset: number, signal: AbortSignal) => Promise<Page<T>>,
  offset: number,
  signal: AbortSignal
): Promise<Page<T>> {
  let nextOffset = offset;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal.throwIfAborted();
    const page = await load(nextOffset, signal);
    signal.throwIfAborted();
    const lastOffset = page.total === 0 ? 0 : Math.floor((page.total - 1) / page.limit) * page.limit;
    if (page.offset <= lastOffset) return page;
    nextOffset = lastOffset;
  }
  throw new Error("曲库正在变化，请稍后重试。");
}

export function useLibraryPage<T>(
  enabled: boolean,
  scope: string,
  revision: number,
  limit: number,
  load: (offset: number, signal: AbortSignal) => Promise<Page<T>>,
  debounce = 0
) {
  const [cursor, setCursor] = useState({ scope, offset: 0 });
  const offset = cursor.scope === scope ? cursor.offset : 0;
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([scope, offset, revision, attempt]);
  const [result, setResult] = useState<{ key: string; page: Page<T>; error: string; loading: boolean } | null>(null);
  const loader = useRef(load);
  loader.current = load;
  const requests = useRef(createLatestRequest());
  const recoveredKey = useRef<string | null>(null);

  useEffect(() => {
    const request = requests.current.begin();
    if (!enabled) {
      recoveredKey.current = null;
      return () => requests.current.cancel();
    }
    if (recoveredKey.current === key) {
      recoveredKey.current = null;
      return () => requests.current.cancel();
    }
    recoveredKey.current = null;
    const timer = window.setTimeout(async () => {
      try {
        const page = await loadValidPage(loader.current, offset, request.signal);
        if (!request.isCurrent()) return;
        const resolvedKey = JSON.stringify([scope, page.offset, revision, attempt]);
        if (page.offset !== offset) {
          // Keep future refreshes on the recovered page and reuse its response.
          recoveredKey.current = resolvedKey;
          setCursor((previous) => previous.scope === scope && previous.offset === offset ? { scope, offset: page.offset } : previous);
        }
        setResult({ key: resolvedKey, page, error: "", loading: false });
      } catch (error) {
        if (request.isCurrent()) setResult({ key, page: { items: [], total: 0, limit, offset }, error: error instanceof Error ? error.message : "加载失败，请重试。", loading: false });
      }
    }, debounce);
    return () => {
      window.clearTimeout(timer);
      requests.current.cancel();
    };
  }, [enabled, key, offset, limit, debounce]);

  const current = result?.key === key ? result : null;
  return {
    page: current?.page ?? { items: [], total: 0, limit, offset },
    loading: enabled && !current,
    error: current?.error ?? "",
    setOffset: (nextOffset: number) => {
      requests.current.cancel();
      setCursor({ scope, offset: Math.max(0, nextOffset) });
    },
    retry: () => setAttempt((value) => value + 1),
    replaceItems: (replace: (items: T[]) => T[]) => setResult((value) => value ? { ...value, page: { ...value.page, items: replace(value.page.items) } } : value)
  };
}
