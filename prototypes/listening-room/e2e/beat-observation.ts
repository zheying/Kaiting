import type { Page } from "@playwright/test";

export type LightSample = { time: number; wall: number; rms: number; power: number[]; angles: number[]; origins: number[] };
type BeatProbe = { samples: LightSample[]; capture: boolean; brightest: number; dimmest: number; peak: string; rest: string };
type BeatWindow = Window & { beatProbe: BeatProbe };

/** 只观察实际音频采样和提交给 WebGL 的灯具数据，不访问或改写应用状态。 */
export async function observeBeats(page: Page) {
  await page.addInitScript(() => {
    const probe: BeatProbe = { samples: [], capture: false, brightest: 0, dimmest: Infinity, peak: "", rest: "" };
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
      if (name === "sources[0]") { power = data.filter((_, i) => i % 4 === 3); origins = data.filter((_, i) => i % 4 !== 3); }
      if (name === "directions[0]") angles = data.filter((_, i) => i % 4 === 3);
    };
    const draw = WebGLRenderingContext.prototype.drawArrays;
    WebGLRenderingContext.prototype.drawArrays = function (mode, first, count) {
      draw.call(this, mode, first, count);
      const audio = document.querySelector("audio");
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

// 需求参考音源：已知时刻的低频/宽频敲击、持续低音、静音；通过媒体请求提供给真实音频图。
export const referenceHits = [.35, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5];
export function percussionReference() {
  const rate = 48_000, length = rate * 16;
  const wav = Buffer.alloc(44 + length * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(length * 2, 40);
  let seed = 1979;
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    let value = t < 12 ? (.035 * Math.sin(t * 220 * 2 * Math.PI) + .02 * Math.sin(t * 440 * 2 * Math.PI)) * Math.min(1, t / .3) : 0;
    for (const [index, hit] of referenceHits.entries()) {
      const elapsed = t - hit;
      if (elapsed < 0 || elapsed > .3) continue;
      const attack = Math.min(1, elapsed / .003);
      value += index % 2 === 0
        ? .68 * Math.sin(2 * Math.PI * (65 * elapsed + .7 * (1 - Math.exp(-elapsed / .025)))) * Math.exp(-elapsed / .055) * attack
        : .65 * (seed / 0xffffffff * 2 - 1) * Math.exp(-elapsed / .04) * attack;
    }
    if (t >= 8 && t < 11) value += .42 * Math.sin(t * 80 * 2 * Math.PI) * Math.min(1, (t - 8) / .15, (11 - t) / .15);
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2);
  }
  return wav;
}
