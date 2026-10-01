import type { Page } from "@playwright/test";

export type LightSample = { time: number; wall: number; rms: number; power: number[]; angles: number[]; origins: number[] };
type BeatProbe = { fixedOrigins: number[]; maxDisplacement: number; samples: LightSample[]; capture: boolean; brightest: number; dimmest: number; peak: string; rest: string };
type BeatWindow = Window & { beatProbe: BeatProbe };

/** 只观察实际音频采样和提交给 WebGL 的灯具数据，不访问或改写应用状态。 */
export async function observeBeats(page: Page) {
  await page.addInitScript(() => {
    const probe: BeatProbe = { fixedOrigins: [], maxDisplacement: 0, samples: [], capture: false, brightest: 0, dimmest: Infinity, peak: "", rest: "" };
    (window as unknown as BeatWindow).beatProbe = probe;
    let rms = 0, power: number[] = [], angles: number[] = [], origins: number[] = [];
    const read = AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatTimeDomainData = function (values) {
      read.call(this, values);
      rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    };
    const names = new WeakMap<WebGLUniformLocation, string>();
    const locate = WebGLRenderingContext.prototype.getUniformLocation;
    WebGLRenderingContext.prototype.getUniformLocation = function (program, name) {
      const location = locate.call(this, program, name);
      if (location) names.set(location, name);
      return location;
    };
    const submit = WebGLRenderingContext.prototype.uniform4fv;
    WebGLRenderingContext.prototype.uniform4fv = function (location, values) {
      submit.call(this, location, values);
      const name = location ? names.get(location) : "";
      const data = Array.from(values);
      if (name === "sources[0]") {
        power = data.filter((_, i) => i % 4 === 3); origins = data.filter((_, i) => i % 4 !== 3);
        if (!probe.fixedOrigins.length) probe.fixedOrigins = origins;
        else for (let i = 0; i < origins.length; i++) probe.maxDisplacement = Math.max(probe.maxDisplacement, Math.abs(origins[i] - probe.fixedOrigins[i]));
      }
      if (name === "directions[0]") angles = data.filter((_, i) => i % 4 === 3);
    };
    const draw = WebGLRenderingContext.prototype.drawArrays;
    WebGLRenderingContext.prototype.drawArrays = function (mode, first, count) {
      draw.call(this, mode, first, count);
      const audio = (window as unknown as { atmosphereObservation: { media: HTMLAudioElement[] } }).atmosphereObservation.media.find((item) => !item.paused && item.currentSrc);
      if (!audio || audio.paused || !power.length) return;
      if (probe.samples.length < 12_000) probe.samples.push({ time: audio.currentTime, wall: performance.now(), rms, power, angles, origins });
      if (probe.capture) {
        const total = power.reduce((sum, value) => sum + value, 0);
        if (total > probe.brightest) { probe.brightest = total; probe.peak = (this.canvas as HTMLCanvasElement).toDataURL(); }
        if (total < probe.dimmest) { probe.dimmest = total; probe.rest = (this.canvas as HTMLCanvasElement).toDataURL(); }
      }
    };
  });
}

export async function resetBeatObservation(page: Page, capture = false) {
  await page.evaluate((capture) => {
    const probe = (window as unknown as BeatWindow).beatProbe;
    probe.samples = []; probe.capture = capture; probe.brightest = 0; probe.dimmest = Infinity; probe.peak = probe.rest = "";
  }, capture);
}
export const beatObservation = (page: Page) => page.evaluate(() => (window as unknown as BeatWindow).beatProbe);
export const brightest = (sample: LightSample) => Math.max(...sample.power);
