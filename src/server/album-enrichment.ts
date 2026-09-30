import type { Album, AlbumEnrichmentStatus, AlbumMetadataLookup } from "../shared/types.js";
import type { AppConfig } from "./config.js";
import type { DatabaseHandle } from "./db.js";
import type { Scanner } from "./scanner.js";

/** A separate, serial queue: network lookups never hold up a local library scan. */
export function createAlbumEnricher(config: AppConfig, database: DatabaseHandle, scanner: Scanner,
  lookup: (album: Album) => Promise<AlbumMetadataLookup>, onError: (error: unknown) => void = () => undefined) {
  const enabled = config.enableOnlineMetadata && config.autoCompleteAlbumMetadata === true;
  const initial = (): AlbumEnrichmentStatus => ({ enabled, state: "idle", total: 0, checked: 0, updated: 0, skipped: 0, failed: 0, finishedAt: null });
  let status = initial();
  let generation = 0, stopped = false, requested = false, retries = 0;
  let pending: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function cancel() {
    generation++;
    requested = false;
    clearTimeout(retryTimer);
    status = initial();
  }

  async function pass(token: number) {
    const root = database.getLibraryRoot();
    const active = () => !stopped && token === generation && !scanner.isRunning() && root === database.getLibraryRoot();
    status = { ...initial(), state: "running" };
    let offset = 0, consecutiveErrors = 0;
    do {
      if (!active()) return;
      const page = database.pageAlbums({ limit: 100, offset });
      status.total = page.total;
      for (const album of page.items) {
        if (!active()) return;
        const metadata = database.getAlbumMetadata(album.key);
        if (!metadata || metadata.autoFillBlocked || (metadata.album.year !== null && metadata.album.genre?.trim())) {
          status.checked++; status.skipped++; continue;
        }
        try {
          const result = await lookup(metadata.album);
          if (!active()) return;
          status.checked++;
          if (result.partial) { status.failed++; consecutiveErrors++; }
          else {
            consecutiveErrors = 0;
            if (database.completeAlbumMetadata(album.key, result, metadata.revision) === "updated") status.updated++;
            else status.skipped++;
          }
        } catch (error) {
          if (!active()) return;
          status.checked++; status.failed++; consecutiveErrors++;
          onError(error);
        }
        // Stop hammering an offline/rate-limited provider; retry later in a bounded batch.
        if (consecutiveErrors >= 3) break;
      }
      offset += page.items.length;
      if (offset >= page.total || !page.items.length || consecutiveErrors >= 3) break;
    } while (active());
    if (!active()) return;
    status.finishedAt = new Date().toISOString();
    status.state = "completed";
    if (status.failed && retries < 2) {
      status.state = "waiting";
      retryTimer = setTimeout(() => { retries++; schedule(); }, retries === 0 ? 60_000 : 300_000);
      retryTimer.unref();
    }
  }

  function schedule() {
    if (!enabled || stopped || scanner.isRunning()) return;
    requested = true;
    if (pending) return;
    pending = Promise.resolve().then(async () => {
      while (requested && !stopped && !scanner.isRunning()) {
        requested = false;
        try { await pass(generation); }
        catch (error) { if (!stopped) { status.state = "completed"; status.failed++; onError(error); } }
      }
    }).finally(() => { pending = null; });
  }

  function trigger() { if (!enabled || stopped) return; cancel(); retries = 0; schedule(); }
  const unsubscribe = enabled ? scanner.subscribe?.((event) => {
    if (event.type === "started") cancel();
    else if (event.complete) trigger();
  }) : undefined;

  return {
    status: (): AlbumEnrichmentStatus => ({ ...status }),
    trigger,
    start() {
      // Catch up existing libraries after an upgrade. Never enrich a failed or partial scan.
      const scan = database.latestScan();
      if (scan?.status === "completed" && scan.errorCount === 0 && scan.scannedFiles === scan.totalFiles
        && scan.totalFiles === database.summary().trackCount) trigger();
    },
    stop() { stopped = true; cancel(); unsubscribe?.(); },
    async whenIdle() { await pending; }
  };
}
