import type { Page } from "@playwright/test";

type Observation = { media: HTMLAudioElement[]; analysers: AnalyserNode[]; connections: number; gains: GainNode[]; samples: { at: number; index: number; time: number; rms: number }[]; events: { type: string; at: number }[] };
type ObservedWindow = Window & { atmosphereObservation: Observation };

/** 只观察浏览器音源和事件，不改变播放器状态、采样或媒体事件。 */
export async function observeAtmosphere(page: Page) {
  await page.addInitScript(() => {
    const state: Observation = { media: [], analysers: [], connections: 0, gains: [], samples: [], events: [] };
    (window as unknown as ObservedWindow).atmosphereObservation = state;
    window.Audio = new Proxy(window.Audio, { construct(target, args) {
      const audio = Reflect.construct(target, args) as HTMLAudioElement;
      state.media.push(audio);
      for (const type of ["pause", "emptied", "loadstart", "seeking", "waiting", "stalled"]) audio.addEventListener(type, () => state.events.push({ type, at: performance.now() }));
      return audio;
    } });
    if (typeof AudioContext === "undefined") return;
    const gain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function () { const node = gain.call(this); state.gains.push(node); return node; };
    const source = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function (media) { state.connections++; return source.call(this, media); };
    const analyser = AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser = function () { const node = analyser.call(this); state.analysers.push(node); return node; };
    const wave = new Float32Array(2048);
    window.setInterval(() => {
      const audio = state.media.find((item) => !item.paused && item.currentSrc);
      if (!audio) return;
      let rms = 0;
      for (const node of state.analysers) { node.getFloatTimeDomainData(wave); rms = Math.max(rms, Math.sqrt(wave.reduce((sum, n) => sum + n * n, 0) / wave.length)); }
      if (state.samples.length < 5000) state.samples.push({ at: performance.now(), index: state.media.indexOf(audio), time: audio.currentTime, rms });
    }, 25);
  });
}

export const soundSnapshot = (page: Page) => page.evaluate(() => {
  const state = (window as unknown as ObservedWindow).atmosphereObservation;
  const media = state.media.find((item) => !item.paused && item.currentSrc) ?? [...state.media].reverse().find((item) => item.currentSrc);
  const wave = new Float32Array(2048);
  let rms = 0;
  for (const analyser of state.analysers) {
    analyser.getFloatTimeDomainData(wave);
    rms = Math.max(rms, Math.sqrt(wave.reduce((sum, value) => sum + value * value, 0) / wave.length));
  }
  return { index: media ? state.media.indexOf(media) : -1, src: media?.currentSrc, time: media?.currentTime, paused: media?.paused, rms, connections: state.connections, at: performance.now(), events: state.events, gains: state.gains.map((gain) => gain.gain.value), samples: state.samples };
});
