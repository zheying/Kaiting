export class MetadataLookupError extends Error {
  constructor(public readonly statusCode: number, public readonly publicMessage: string) { super(publicMessage); }
}

// Shared by on-demand album searches and the scanner, including concurrent requests.
const schedules = new WeakMap<typeof fetch, { nextAt: number; pending: number }>();
const maxBytes = 1024 * 1024;

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function fetchMusicBrainzJson<T>(url: string, fetcher: typeof fetch = globalThis.fetch): Promise<T> {
  const target = new URL(url);
  if (target.origin !== "https://musicbrainz.org" || !target.pathname.startsWith("/ws/2/")) throw new Error("Unexpected metadata URL");
  let schedule = schedules.get(fetcher);
  if (!schedule) { schedule = { nextAt: 0, pending: 0 }; schedules.set(fetcher, schedule); }
  if (schedule.pending >= 8) throw new MetadataLookupError(429, "查询较多，请稍后再试。");
  const wait = Math.max(0, schedule.nextAt - Date.now());
  schedule.nextAt = Date.now() + wait + 1100;
  schedule.pending++;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 16000);
  try {
    if (wait > 0) await delay(wait, controller.signal);
    const response = await fetcher(url, {
      headers: { Accept: "application/json", "User-Agent": "NASMusicLibrary/0.1 (local-first personal music library)" },
      signal: controller.signal, redirect: "error"
    });
    if (response.status === 429 || response.status === 503) {
      schedule.nextAt = Math.max(schedule.nextAt, Date.now() + 5000);
      await response.body?.cancel();
      throw new MetadataLookupError(503, "MusicBrainz 暂时繁忙，请稍后重试。");
    }
    if (!response.ok || Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new Error("Metadata response rejected");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty metadata response");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new Error("Metadata response too large");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch (error) {
    if (error instanceof MetadataLookupError) throw error;
    throw new MetadataLookupError(502, controller.signal.aborted ? "查询超时，请稍后重试；也可以手动填写。" : "暂时无法连接 MusicBrainz，请稍后重试；也可以手动填写。");
  } finally { clearTimeout(timeout); schedule.pending--; }
}
