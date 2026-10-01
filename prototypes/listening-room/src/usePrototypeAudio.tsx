import { useCallback, useEffect, useRef, useState } from "react";
import { AtmosphereAudio } from "./atmosphere-audio";
import type { MusicCatalog, PreparedMusic } from "./lighting-program";

type Options = {
  trackId: string; playing: boolean; position: number; volume: number;
  onPosition: (position: number) => void; onEnded: () => void;
};

/** 播放会话属于音乐室；页面与氛围模式只使用这一个音源。 */
export function usePrototypeAudio(options: Options) {
  const element = useRef<HTMLAudioElement>(null);
  const latest = useRef(options);
  latest.current = options;
  const engineRef = useRef<AtmosphereAudio | null>(null);
  const disposal = useRef<number | null>(null);
  const [audio, setAudio] = useState<AtmosphereAudio | null>(null);
  const [catalog, setCatalog] = useState<MusicCatalog | null>(null);
  const catalogCache = useRef<MusicCatalog | null>(null);
  const [prepared, setPrepared] = useState<PreparedMusic | null>(null);
  const [loadedId, setLoadedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [audioError, setAudioError] = useState("");
  const [retrySource, setRetrySource] = useState(0);
  const realAudio = catalog?.enabled !== false;
  const sourceBusy = Boolean(options.trackId) && (loading || (loadedId !== options.trackId && !sourceError && !audioError));
  // 歌词直接读取当前音源时钟；切歌准备期间不得读到上一首的时间。
  const readPosition = useCallback(() => {
    const media = element.current;
    if (catalogCache.current?.enabled && media?.dataset.trackId === latest.current.trackId && media.readyState >= 1) {
      return Math.min(Number.isFinite(media.duration) ? media.duration : Infinity, media.currentTime);
    }
    // 原创合成音源循环播放，演示歌词沿用歌曲快照的模拟时间轴。
    return latest.current.position;
  }, []);

  useEffect(() => {
    if (!element.current) return;
    if (disposal.current !== null) window.clearTimeout(disposal.current);
    try {
      engineRef.current ??= new AtmosphereAudio(element.current, setAudioError);
      setAudio(engineRef.current);
      // StrictMode 会立即重放 effect；同一媒体元素不能重复绑定 Web Audio。
      return () => { disposal.current = window.setTimeout(() => { engineRef.current?.dispose(); engineRef.current = null; }, 0); };
    } catch { setAudioError("这个浏览器暂时无法使用音乐播放音源。"); }
  }, []);

  useEffect(() => {
    if (!audio) return;
    const controller = new AbortController();
    audio.stopSource(); setPrepared(null); setLoadedId(""); setSourceError(""); setAudioError("");
    if (!options.trackId) { audio.leave(); setLoading(false); return; }
    setLoading(true);
    const trackId = options.trackId;
    const read = async <T,>(url: string): Promise<T> => {
      const response = await fetch(url, { signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "音源暂时不可用，请重试。");
      return body as T;
    };
    void (async () => {
      const available = catalogCache.current ?? await read<MusicCatalog>("/__prototype/music/catalog");
      if (controller.signal.aborted) return;
      catalogCache.current = available; setCatalog(available);
      if (available.enabled) {
        const result = await read<PreparedMusic>(`/__prototype/music/prepare/${trackId}`);
        if (controller.signal.aborted || latest.current.trackId !== trackId) return;
        audio.setSource(result.url, false, latest.current.position, trackId);
        setPrepared(result);
      } else {
        audio.setSource(`${import.meta.env.BASE_URL}audio/atmosphere-demo.wav`, true, latest.current.position, trackId);
      }
      setLoadedId(trackId); setLoading(false);
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setSourceError(error instanceof Error ? error.message : "真实音源暂时不可用。"); setLoading(false);
    });
    return () => { controller.abort(); audio.stopSource(); };
    // 模式和路由不参与音源生命周期；仅切歌、清空当前歌曲或显式重试才重载。
  }, [audio, options.trackId, retrySource]);

  useEffect(() => {
    if (loadedId === options.trackId && !sourceBusy && !sourceError) audio?.sync(options.playing, options.position, options.volume, options.trackId);
  }, [audio, loadedId, sourceBusy, sourceError, options.playing, options.position, options.volume, options.trackId]);

  function unlock() { void audio?.unlock(); }
  function retryAudio() {
    if (sourceError) { unlock(); setRetrySource((value) => value + 1); }
    else void audio?.retry();
  }
  function seek(position: number) { audio?.seek(position); options.onPosition(position); }

  const mediaElement = <audio ref={element} preload="auto" hidden data-testid="atmosphere-audio"
    onTimeUpdate={(event) => {
      if (realAudio && loadedId === latest.current.trackId && event.currentTarget.dataset.trackId === latest.current.trackId) latest.current.onPosition(event.currentTarget.currentTime);
    }}
    onEnded={() => { if (realAudio && loadedId === latest.current.trackId) latest.current.onEnded(); }}
  />;
  return { audio, catalog, prepared: prepared?.track.id === options.trackId ? prepared : null, sourceBusy, audioError: sourceError || audioError, realAudio, mediaElement, unlock, retryAudio, seek, readPosition };
}

export type PrototypeAudio = ReturnType<typeof usePrototypeAudio>;
