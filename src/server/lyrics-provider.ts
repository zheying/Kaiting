export class LyricsLookupError extends Error {
  constructor(public readonly retryAfter?: number) { super("歌词服务暂时不可用，请稍后重试"); }
}

const schedules = new WeakMap<typeof fetch, { nextAt: number; blockedUntil: number }>();

// A provider outage must stay distinguishable from a successful search with no matches.
export async function fetchLyricsJson(url: URL, fetcher: typeof fetch, deadline: AbortSignal): Promise<unknown> {
  let schedule = schedules.get(fetcher);
  if (!schedule) { schedule = { nextAt: 0, blockedUntil: 0 }; schedules.set(fetcher, schedule); }
  if (schedule.blockedUntil > Date.now()) throw new LyricsLookupError(Math.ceil((schedule.blockedUntil - Date.now()) / 1000));
  const signal = AbortSignal.any([deadline, AbortSignal.timeout(12_000)]);
  const wait = Math.max(0, schedule.nextAt - Date.now());
  schedule.nextAt = Date.now() + wait + 250;
  try {
    if (wait > 0) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, wait);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    if (schedule.blockedUntil > Date.now()) throw new LyricsLookupError(Math.ceil((schedule.blockedUntil - Date.now()) / 1000));
    const response = await fetcher(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": "NASMusicLibrary/0.1 (local-first personal music library)" },
      signal, redirect: "error"
    });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (response.status === 429) {
      const raw = response.headers.get("retry-after");
      const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? (Date.parse(raw) - Date.now()) / 1000 : 60;
      const retryAfter = Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 60;
      schedule.blockedUntil = Date.now() + retryAfter * 1000;
      await response.body?.cancel(); throw new LyricsLookupError(retryAfter);
    }
    if (!response.ok || Number(response.headers.get("content-length")) > 1024 * 1024) {
      await response.body?.cancel(); throw new LyricsLookupError();
    }
    const reader = response.body?.getReader();
    if (!reader) throw new LyricsLookupError();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1024 * 1024) throw new LyricsLookupError();
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof LyricsLookupError) throw error;
    throw new LyricsLookupError();
  }
}
