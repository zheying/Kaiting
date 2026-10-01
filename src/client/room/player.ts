import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "./data.js";
import type { UserPreferences } from "../../shared/accounts.js";
import type { PlaybackPhase } from "./room-state.js";
import { api, streamUrl } from "../api.js";
import { sizedArtworkUrl } from "../artwork.js";
import { isDirectMediaUrl, mediaConnectionFailed, mediaUrl } from "../media-connection.js";
import { clampPlaybackPosition, isPlaybackAtEnd, playbackLoadPosition } from "./playback-position.js";
import { AtmosphereAudio } from "./atmosphere-audio.js";

export function usesTranscodedStream(track: Pick<Track, "path" | "codec" | "container" | "formatGroup">) {
  const name = track.path.toLowerCase();
  const alac = /alac|apple lossless/i.test(`${track.codec} ${track.container} ${track.formatGroup}`);
  if ((name.endsWith(".m4a") || name.endsWith(".alac")) && alac) return true;
  return !/\.(mp3|m4a|aac|ogg|opus|wav)$/.test(name);
}
function releaseAudio(audio: HTMLAudioElement) {
  audio.pause(); audio.removeAttribute("src"); audio.load();
}
export function useRoomPlayer(tracks: Track[], preferences: UserPreferences, libraryReady: boolean) {
  const [audioPair] = useState(() => [new Audio(), new Audio()] as const);
  const activeAudio = useRef<HTMLAudioElement>(audioPair[0]);
  const retainedAudio = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasEnded, setHasEnded] = useState(false);
  const [position, setPosition] = useState(0);
  const [seekRevision, setSeekRevision] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(preferences.volume);
  const [shuffle, setShuffle] = useState(preferences.shuffle);
  const [repeat, setRepeat] = useState<0 | 1 | 2>(preferences.repeat);
  const [phase, setPhase] = useState<PlaybackPhase>("ready");
  const trackRef = useRef<Track | null>(null);
  const timelineDuration = useRef(0);
  const syncMediaSession = useRef(() => {});
  const offset = useRef(0);
  const directSeek = useRef<number | null>(null);
  const intention = useRef(false);
  const completed = useRef(false);
  const operation = useRef(0);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelRecovery() { if (recoveryTimer.current) clearTimeout(recoveryTimer.current); recoveryTimer.current = null; }
  const restored = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  const latest = useRef({ queue, currentId, position, shuffle, repeat });
  latest.current = { queue, currentId, position, shuffle, repeat };
  const current = queue.find((track) => track.id === currentId) ?? tracks.find((track) => track.id === currentId);
  // The lyrics view samples the actual media clock locally; the rest of the UI
  // keeps its existing timeupdate cadence. Include the offset for transcoded seeks.
  const readPosition = useCallback(() => completed.current ? timelineDuration.current : directSeek.current ?? Math.min(timelineDuration.current || Infinity, offset.current + activeAudio.current.currentTime), []);
  const [analysisNotice, setAnalysisNotice] = useState("");
  const [analysis] = useState(() => new AtmosphereAudio(() => activeAudio.current, readPosition, setAnalysisNotice));
  const analysisDisposal = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (analysisDisposal.current) clearTimeout(analysisDisposal.current);
    // React StrictMode 重放 effect 时继续使用同一音频图。
    return () => { analysisDisposal.current = setTimeout(() => analysis.dispose(), 0); };
  }, [analysis]);

  function acceptPlayback(audio: HTMLAudioElement) {
    if (audio !== activeAudio.current || !trackRef.current || completed.current) { audio.pause(); return; }
    if (audio.paused) return;
    cancelRecovery();
    intention.current = true;
    const previous = retainedAudio.current;
    retainedAudio.current = audio;
    // Keep the last native player registered until its replacement really plays.
    // Changing its src sooner makes Android briefly remove the lock-screen controls.
    if (previous && previous !== audio) releaseAudio(previous);
    setIsPlaying(true); setPhase("ready");
  }

  function requestPlay() {
    const audio = activeAudio.current;
    const analysisReady = analysis.unlock(audio);
    const generation = ++operation.current;
    intention.current = true;
    void Promise.all([analysisReady, audio.play()]).then(() => {
      if (generation !== operation.current || audio !== activeAudio.current) return;
      acceptPlayback(audio);
      syncMediaSession.current();
    }).catch((error: unknown) => {
      if (generation !== operation.current || audio !== activeAudio.current || (error instanceof DOMException && error.name === "AbortError")) return;
      if (!(error instanceof DOMException && error.name === "NotAllowedError") && recoverDirect(audio)) return;
      intention.current = false; setIsPlaying(false);
      audio.pause();
      setPhase(error instanceof DOMException && error.name === "NotAllowedError" ? "blocked" : navigator.onLine ? "decode" : "offline");
      syncMediaSession.current();
    });
    syncMediaSession.current();
    scheduleRecovery(audio);
  }
  function recoverDirect(audio: HTMLAudioElement) {
    if (audio !== activeAudio.current || !trackRef.current || completed.current || !isDirectMediaUrl(audio.src)) return false;
    const position = readPosition(); const autoplay = intention.current;
    mediaConnectionFailed(audio.src);
    load(trackRef.current, position, autoplay, true);
    return true;
  }
  function scheduleRecovery(audio: HTMLAudioElement) {
    if (recoveryTimer.current || !isDirectMediaUrl(audio.src) || !intention.current) return;
    const source = audio.src; const generation = operation.current; const position = readPosition();
    recoveryTimer.current = setTimeout(() => {
      recoveryTimer.current = null;
      if (generation !== operation.current || audio !== activeAudio.current || audio.src !== source || !intention.current) return;
      if (readPosition() > position + 0.1 && audio.readyState >= 3) { scheduleRecovery(audio); return; }
      recoverDirect(audio);
    }, 4000);
  }
  function load(track: Track, value: number, autoplay: boolean, forcePublic = false) {
    cancelRecovery();
    analysis.resetTransients();
    operation.current++; intention.current = autoplay;
    const outgoing = activeAudio.current;
    outgoing.pause();
    trackRef.current = track;
    timelineDuration.current = track.duration;
    latest.current.currentId = track.id;
    const target = playbackLoadPosition(value, track.duration, autoplay);
    completed.current = target.ended; setHasEnded(target.ended);
    setCurrentId(track.id); setPosition(target.position); setDuration(track.duration); setIsPlaying(false);
    // A saved endpoint is a completed track, not a request for an empty tail stream.
    if (target.ended) {
      offset.current = 0; directSeek.current = null;
      retainedAudio.current = null;
      audioPair.forEach(releaseAudio); setPhase("ready");
      syncMediaSession.current();
      return;
    }
    // Reuse a pending candidate on rapid skips, preserving at most one paused
    // previous source. Never start the replacement while the outgoing audio plays.
    const audio = outgoing === retainedAudio.current ? audioPair.find((item) => item !== outgoing)! : outgoing;
    activeAudio.current = audio;
    const transcode = usesTranscodedStream(track);
    offset.current = transcode ? target.position : 0;
    directSeek.current = transcode ? null : target.position;
    // 跨源音频须带凭证并通过 CORS，Web Audio 分析才能继续输出有效声音。
    audio.crossOrigin = "use-credentials";
    audio.src = mediaUrl(streamUrl(track.id, transcode ? target.position : undefined), forcePublic);
    audio.preload = "metadata";
    setPhase(autoplay ? transcode ? "transcoding" : "loading" : "ready");
    // Called directly from the click/touch handler, retaining the browser's user activation.
    if (autoplay) requestPlay();
    else audio.load();
    syncMediaSession.current();
  }
  function play(track: Track | undefined, source?: Track[]) {
    if (!track) return;
    const items = latest.current.queue;
    const nextQueue = source?.length ? [...new Map(source.map((item) => [item.id, item])).values()] : items.some((item) => item.id === track.id) ? items : [...items, track];
    latest.current.queue = nextQueue;
    setQueue(nextQueue);
    load(track, 0, true);
  }
  function resumePlayback() {
    if (!trackRef.current) return;
    const audio = activeAudio.current;
    // Replaying audio.play() would restart only the current transcoded segment.
    if (completed.current || audio.ended) load(trackRef.current, 0, true);
    else if (audio.error) load(trackRef.current, readPosition(), true);
    else if (!intention.current || audio.paused) requestPlay();
  }
  function pausePlayback() {
    cancelRecovery();
    analysis.resetTransients();
    operation.current++; intention.current = false;
    audioPair.forEach((audio) => audio.pause()); setIsPlaying(false); setPhase("ready");
    syncMediaSession.current();
  }
  function togglePlay() {
    if (intention.current) pausePlayback();
    else resumePlayback();
  }
  function seek(value: number) {
    analysis.resetTransients();
    const audio = activeAudio.current;
    const track = trackRef.current;
    if (!track || !Number.isFinite(value)) return;
    const total = timelineDuration.current;
    const next = clampPlaybackPosition(value, total);
    // Persist an explicit seek even while paused, without writing every timeupdate.
    setSeekRevision((revision) => revision + 1);
    if (isPlaybackAtEnd(next, total)) { finishTrack(intention.current); return; }
    if (completed.current || usesTranscodedStream(track)) { load(track, next, intention.current); return; }
    setPosition(next); setHasEnded(false);
    directSeek.current = next;
    try { audio.currentTime = next; directSeek.current = null; } catch { /* Apply when metadata is available. */ }
    syncMediaSession.current();
  }
  function nextTrack(auto = false) {
    const state = latest.current;
    const index = state.queue.findIndex((track) => track.id === state.currentId);
    if (!state.queue.length) return;
    if (auto && state.repeat === 2) { load(state.queue[Math.max(0, index)], 0, true); return; }
    if (auto && index >= state.queue.length - 1 && state.repeat === 0 && !state.shuffle) { intention.current = false; setIsPlaying(false); return; }
    const next = state.shuffle && state.queue.length > 1 ? (index + 1 + Math.floor(Math.random() * (state.queue.length - 1))) % state.queue.length : (index + 1) % state.queue.length;
    play(state.queue[next]);
  }
  function finishTrack(advance: boolean) {
    cancelRecovery();
    const audio = activeAudio.current;
    const track = trackRef.current;
    if (!track) return;
    const end = timelineDuration.current || offset.current + audio.currentTime;
    timelineDuration.current = end;
    operation.current++; intention.current = false; completed.current = true;
    directSeek.current = null; offset.current = 0;
    audio.pause();
    setPosition(end); setHasEnded(true); setIsPlaying(false); setPhase("ready");
    if (advance) nextTrack(true);
    syncMediaSession.current();
  }
  function previousTrack() {
    const state = latest.current;
    if (readPosition() > 3) { seek(0); return; }
    const index = state.queue.findIndex((track) => track.id === state.currentId);
    play(state.queue[(Math.max(index, 0) - 1 + state.queue.length) % state.queue.length]);
  }
  function retry() { if (trackRef.current) load(trackRef.current, completed.current || activeAudio.current.ended ? 0 : readPosition(), true); }
  function clear() {
    cancelRecovery();
    operation.current++; intention.current = false; completed.current = false; trackRef.current = null;
    directSeek.current = null; offset.current = 0; timelineDuration.current = 0;
    latest.current.queue = []; latest.current.currentId = "";
    retainedAudio.current = null;
    audioPair.forEach(releaseAudio);
    setQueue([]); setCurrentId(""); setPosition(0); setDuration(0); setIsPlaying(false); setHasEnded(false); setPhase("ready");
    syncMediaSession.current();
  }
  const handlers = useRef({ nextTrack, seek, resumePlayback, pausePlayback, previousTrack, finishTrack, acceptPlayback, recoverDirect, scheduleRecovery });
  handlers.current = { nextTrack, seek, resumePlayback, pausePlayback, previousTrack, finishTrack, acceptPlayback, recoverDirect, scheduleRecovery };
  useEffect(() => {
    if (restored.current || !libraryReady) return;
    restored.current = true;
    const map = new Map(tracks.map((track) => [track.id, track]));
    const queue = preferences.queue.map((id) => map.get(id)).filter((track): track is Track => Boolean(track));
    latest.current.queue = queue;
    setQueue(queue); setHydrated(true);
    const track = map.get(preferences.currentId);
    if (track) { if (!queue.some((item) => item.id === track.id)) queue.unshift(track); setQueue(queue); load(track, preferences.position, false); }
  }, [tracks, libraryReady]);
  useEffect(() => { analysis.setVolume(volume, audioPair); }, [analysis, audioPair, volume]);
  useEffect(() => {
    const removeListeners = audioPair.map((audio) => {
      const isActive = () => audio === activeAudio.current && Boolean(trackRef.current) && !completed.current;
      const progress = () => {
        if (!isActive() || directSeek.current !== null) return;
        const next = offset.current + audio.currentTime;
        setPosition(Math.min(timelineDuration.current || Infinity, next));
      };
      const metadata = () => {
        const track = trackRef.current; if (!isActive() || !track || audio.readyState === 0) return;
        timelineDuration.current = usesTranscodedStream(track) ? track.duration || (Number.isFinite(audio.duration) ? offset.current + audio.duration : 0) : Number.isFinite(audio.duration) ? audio.duration : track.duration;
        setDuration(timelineDuration.current);
        if (directSeek.current !== null) { try { audio.currentTime = directSeek.current; directSeek.current = null; } catch { /* Try again on durationchange. */ } }
      };
      const play = () => { if (!isActive()) audio.pause(); };
      const playing = () => handlers.current.acceptPlayback(audio);
      const pause = () => { if (isActive() && audio.paused && !audio.ended && audio.readyState > 0) { intention.current = false; setIsPlaying(false); } };
      const waiting = () => { if (isActive() && intention.current && !audio.error && trackRef.current) { setPhase(usesTranscodedStream(trackRef.current) && audio.readyState === 0 ? "transcoding" : "buffering"); handlers.current.scheduleRecovery(audio); } };
      const ended = () => { if (isActive() && audio.ended) handlers.current.finishTrack(true); };
      const error = () => {
        if (!isActive() || !audio.error) return;
        if (handlers.current.recoverDirect(audio)) return;
        const generation = ++operation.current;
        intention.current = false; setIsPlaying(false);
        audio.pause();
        setPhase(!navigator.onLine || audio.error?.code === 2 ? "offline" : "decode");
        const id = trackRef.current?.id;
        if (id) void api.availability(id).catch((reason) => { if (generation === operation.current && reason?.status === 404) setPhase("missing"); });
      };
      audio.addEventListener("timeupdate", progress); audio.addEventListener("loadedmetadata", metadata); audio.addEventListener("durationchange", metadata);
      audio.addEventListener("play", play); audio.addEventListener("playing", playing); audio.addEventListener("pause", pause); audio.addEventListener("waiting", waiting); audio.addEventListener("stalled", waiting); audio.addEventListener("ended", ended); audio.addEventListener("error", error);
      return () => {
        audio.removeEventListener("timeupdate", progress); audio.removeEventListener("loadedmetadata", metadata); audio.removeEventListener("durationchange", metadata);
        audio.removeEventListener("play", play); audio.removeEventListener("playing", playing); audio.removeEventListener("pause", pause); audio.removeEventListener("waiting", waiting); audio.removeEventListener("stalled", waiting); audio.removeEventListener("ended", ended); audio.removeEventListener("error", error);
      };
    });
    return () => {
      cancelRecovery();
      operation.current++; intention.current = false; retainedAudio.current = null;
      removeListeners.forEach((remove) => remove());
      audioPair.forEach(releaseAudio);
    };
  }, [audioPair]);
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    let metadataTrack: Track | null | undefined;
    // Background media events and system commands must not wait for a React
    // render or animation frame. The full timeline includes transcoded offsets.
    const sync = () => {
      const track = trackRef.current;
      const audio = activeAudio.current;
      if (metadataTrack !== track) {
        metadataTrack = track;
        try {
          if (!track) session.metadata = null;
          else if (typeof MediaMetadata !== "undefined") session.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album ?? "", artwork: track.hasArtwork ? [{ src: sizedArtworkUrl(`/api/tracks/${track.id}/artwork`, 512), type: "image/webp" }] : [] });
        } catch { /* Optional metadata must not disable system controls. */ }
      }
      try { session.playbackState = !track ? "none" : intention.current && !completed.current ? "playing" : "paused"; } catch { /* Unsupported platform state. */ }
      try {
        const total = timelineDuration.current;
        if (track && Number.isFinite(total) && total > 0) {
          session.setPositionState?.({ duration: total, position: clampPlaybackPosition(readPosition(), total), playbackRate: Number.isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1 });
        } else session.setPositionState?.();
      } catch { /* Position reporting is optional on older platforms. */ }
    };
    const seekBy = (direction: number, value = 10) => {
      if (Number.isFinite(value) && value > 0) handlers.current.seek(readPosition() + direction * value);
    };
    const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => handlers.current.resumePlayback()],
      ["pause", () => handlers.current.pausePlayback()],
      ["nexttrack", () => handlers.current.nextTrack()],
      ["previoustrack", () => handlers.current.previousTrack()],
      ["seekto", ({ seekTime }) => { if (seekTime !== undefined) handlers.current.seek(seekTime); }],
      ["seekbackward", ({ seekOffset }) => seekBy(-1, seekOffset)],
      ["seekforward", ({ seekOffset }) => seekBy(1, seekOffset)]
    ];
    // Bind once for the player's lifetime; switching tracks must not leave
    // the OS without handlers or temporarily clear the current notification.
    for (const [action, handler] of actions) { try { session.setActionHandler(action, handler); } catch { /* Unsupported platform action. */ } }
    const events = ["play", "playing", "pause", "timeupdate", "loadedmetadata", "durationchange", "seeked", "ratechange", "ended", "error", "emptied"] as const;
    for (const audio of audioPair) for (const event of events) audio.addEventListener(event, sync);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pageshow", sync);
    syncMediaSession.current = sync;
    sync();
    return () => {
      syncMediaSession.current = () => {};
      for (const audio of audioPair) for (const event of events) audio.removeEventListener(event, sync);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pageshow", sync);
      for (const [action] of actions) { try { session.setActionHandler(action, null); } catch { /* Unsupported platform action. */ } }
      try { session.metadata = null; } catch { /* Unsupported platform metadata. */ }
      try { session.playbackState = "none"; } catch { /* Unsupported platform state. */ }
      try { session.setPositionState?.(); } catch { /* Unsupported platform position. */ }
    };
  }, [audioPair, readPosition]);
  return { hydrated, queue, setQueue, currentId, current, isPlaying, hasEnded, position, readPosition, analysis, analysisNotice, seekRevision, duration, volume, setVolume, shuffle, setShuffle, repeat, setRepeat, phase, play, togglePlay, nextTrack, previousTrack, seek, retry, clear };
}
