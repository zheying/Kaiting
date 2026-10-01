import type { Page } from "@playwright/test";

type Sample = { wall: number; time: number; paused: boolean; ready: number; rms: number; sameElement: boolean };
type Event = { type: string; wall: number; time: number };
type Continuity = { sources: number; events: Event[]; samples: Sample[]; element: HTMLMediaElement | null; analyser: AnalyserNode | null };
type ObservedWindow = Window & { continuity: Continuity };

export async function observeContinuity(page: Page) {
  await page.addInitScript(() => {
    const observation: Continuity = { sources: 0, events: [], samples: [], element: null, analyser: null };
    (window as unknown as ObservedWindow).continuity = observation;
    const createSource = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function (element) {
      observation.sources++; observation.element ??= element;
      return createSource.call(this, element);
    };
    const createAnalyser = AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser = function () {
      const analyser = createAnalyser.call(this); observation.analyser = analyser; return analyser;
    };
    for (const type of ["pause", "emptied", "loadstart", "seeking", "waiting", "stalled"]) document.addEventListener(type, (event) => {
      if (event.target instanceof HTMLMediaElement) observation.events.push({ type, wall: performance.now(), time: event.target.currentTime });
    }, true);
    const wave = new Float32Array(2048);
    window.setInterval(() => {
      const element = document.querySelector("audio");
      if (!element) return;
      observation.analyser?.getFloatTimeDomainData(wave);
      const rms = Math.sqrt(wave.reduce((sum, value) => sum + value * value, 0) / wave.length);
      observation.samples.push({ wall: performance.now(), time: element.currentTime, paused: element.paused, ready: element.readyState, rms, sameElement: element === observation.element });
    }, 25);
  });
}

export const continuityMark = (page: Page) => page.evaluate(() => performance.now());
export const continuitySince = (page: Page, since: number) => page.evaluate((from) => {
  const { sources, events, samples } = (window as unknown as ObservedWindow).continuity;
  return { sources, events: events.filter((event) => event.wall >= from), samples: samples.filter((sample) => sample.wall >= from) };
}, since);
