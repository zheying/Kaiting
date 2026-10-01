import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { AppConfig } from "./config.js";
import { safeRealPath } from "./pathSafety.js";
import { buildLightingProgram, lightingLooks, LIGHTING_PROGRAM_VERSION, type AudioFeature, type LightingProgram } from "../shared/lighting-program.js";

export class LightingError extends Error {
  constructor(readonly statusCode: number, readonly publicMessage: string) { super(publicMessage); }
}

async function decodeAudio(signal: AbortSignal, args: string[], consume: (chunk: Buffer) => void) {
  if (signal.aborted) throw new LightingError(503, "灯光分析已取消");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file,pipe", ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let finished = false, bytes = 0;
    const finish = (error?: Error) => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) { child.kill("SIGKILL"); reject(error); } else resolve();
    };
    const abort = () => finish(new LightingError(503, "灯光分析已取消"));
    const timer = setTimeout(() => finish(new LightingError(503, "本曲分析超时")), 60_000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 12_000 * 4 * 2701) { finish(new LightingError(422, "录音超出分析范围")); return; }
      try { consume(chunk); } catch { finish(new LightingError(422, "音频无法分析")); }
    });
    child.once("error", () => finish(new LightingError(503, "音频分析工具不可用")));
    child.once("close", (code) => finish(code === 0 ? undefined : new LightingError(422, "音频无法分析")));
  });
}

export async function analyzeMusic(file: string, signal: AbortSignal): Promise<LightingProgram> {
    const frames: AudioFeature[] = [];
    const sampleRate = 12_000, frameSize = 1200;
    const lowRate = 1 - Math.exp(-2 * Math.PI * 180 / sampleRate), highRate = 1 - Math.exp(-2 * Math.PI * 2200 / sampleRate);
    let low = 0, lowHigh = 0, sum = 0, bassSum = 0, trebleSum = 0, count = 0, previousRms = 0, previousBass = 0, fluxMean = .001, lastOnset = -1;
    let tail: Buffer = Buffer.alloc(0);
    await decodeAudio(signal, ["-i", file, "-map", "0:a:0", "-vn", "-t", "2700", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "pipe:1"], (chunk) => {
      const bytes = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      const usable = bytes.length - bytes.length % 4;
      for (let i = 0; i < usable; i += 4) {
        const value = bytes.readFloatLE(i);
        low += lowRate * (value - low); lowHigh += highRate * (value - lowHigh);
        sum += value * value; bassSum += low * low; trebleSum += (value - lowHigh) ** 2;
        if (++count === frameSize) {
          const rms = Math.sqrt(sum / count), bass = Math.sqrt(bassSum / count), treble = Math.sqrt(trebleSum / count), time = frames.length / 10;
          const flux = Math.max(0, rms - previousRms) + Math.max(0, bass - previousBass) * .75;
          const onset = rms > .003 && flux > Math.max(.002, fluxMean * 1.65) && time - lastOnset >= .19 ? 1 : 0;
          if (onset) lastOnset = time;
          fluxMean += (flux - fluxMean) * .12;
          frames.push({ time, rms, bass: Math.min(1, bass / Math.max(.0001, rms)), treble: Math.min(1, treble / Math.max(.0001, rms)), onset });
          previousRms = rms; previousBass = bass; count = sum = bassSum = trebleSum = 0;
        }
      }
      tail = Buffer.from(bytes.subarray(usable));
    });
    if (!frames.length) throw new LightingError(422, "音频没有可分析的声音。");
    return buildLightingProgram(frames, frames.length / 10);
  }

function validProgram(value: LightingProgram): boolean {
  const looks = new Set<string>(lightingLooks.map((look) => look.id));
  return value?.version === LIGHTING_PROGRAM_VERSION && Number.isFinite(value.duration) && value.duration > 0 && value.duration <= 2700
    && Boolean(value.summary) && Object.values(value.summary).every((entry) => typeof entry === "string" || Number.isFinite(entry))
    && Array.isArray(value.cues) && value.cues.length > 0 && value.cues.length <= 400
    && value.cues.every((cue, index) => looks.has(cue.look) && Number.isFinite(cue.start) && Number.isFinite(cue.end)
      && cue.start >= 0 && cue.end > cue.start && cue.end <= value.duration && (index === 0 ? cue.start === 0 : cue.start === value.cues[index - 1].end)
      && [cue.energy, cue.density, cue.bass, cue.brightness, cue.rise].every(Number.isFinite) && typeof cue.reason === "string");
}

/** 按需分析，最多两个解码任务；不参与 stream 准备或在线播放。 */
export function createLightingStore(config: AppConfig, decode: typeof analyzeMusic = analyzeMusic) {
  const pending = new Map<string, { result: Promise<LightingProgram>; controller: AbortController }>();
  let closed = false;
  const version = async (file: string) => {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new LightingError(404, "音乐文件不可访问");
    return `${file}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  };
  async function directory() {
    const data = await fs.realpath(config.dataDir), music = await fs.realpath(config.musicLibraryPath);
    const relative = path.relative(music, data);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new LightingError(503, "灯光缓存目录不可用");
    const target = path.join(data, "lighting");
    try { if ((await fs.lstat(target)).isSymbolicLink()) throw new LightingError(503, "灯光缓存目录不可用"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await fs.mkdir(target, { recursive: true });
    return safeRealPath(data, target);
  }
  async function read(track: { path: string; duration: number }) {
    if (closed) throw new LightingError(503, "灯光分析已停止");
    if (!Number.isFinite(track.duration) || track.duration <= 0 || track.duration > 2700) throw new LightingError(422, "本曲使用实时灯光");
    const root = config.musicLibraryPath;
    let file: string, sourceVersion: string;
    try { file = safeRealPath(root, track.path); sourceVersion = await version(file); }
    catch { throw new LightingError(404, "音乐文件不可访问"); }
    const key = createHash("sha256").update(`${sourceVersion}\0${LIGHTING_PROGRAM_VERSION}`).digest("hex");
    const existing = pending.get(key);
    if (existing) return existing.result;
    if (closed || pending.size >= 2) throw new LightingError(503, "灯光分析繁忙，暂时使用实时灯光");
    const controller = new AbortController();
    const result = (async () => {
      const cache = await directory();
      const target = path.join(cache, `${key}.json`);
      const unchanged = async () => {
        if (closed || config.musicLibraryPath !== root || safeRealPath(root, track.path) !== file || await version(file) !== sourceVersion) throw new LightingError(409, "曲目已经更新，请重新载入灯光");
      };
      try {
        const entry = safeRealPath(cache, target), stat = await fs.stat(entry);
        if (!stat.isFile() || stat.size > 256 * 1024) throw new LightingError(422, "灯光缓存无效");
        const cached = JSON.parse(await fs.readFile(entry, "utf8")) as LightingProgram;
        if (validProgram(cached)) { await unchanged(); return cached; }
      } catch (error) {
        if (error instanceof LightingError && error.statusCode === 409) throw error;
        // 不沿用坏缓存。越界链接只能被原子替换，不能写入链接目标。
      }
      if (closed) throw new LightingError(503, "灯光分析已停止");
      await unchanged();
      const program = await decode(file, controller.signal);
      if (!validProgram(program)) throw new LightingError(422, "音频无法分析");
      await unchanged();
      if (await directory() !== cache) throw new LightingError(409, "灯光缓存位置已改变");
      const temporary = path.join(cache, `${key}-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, JSON.stringify(program), { flag: "wx", mode: 0o600 });
        await unchanged();
        await fs.rename(temporary, target);
      } finally { await fs.unlink(temporary).catch(() => {}); }
      const files = (await fs.readdir(cache)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
      if (files.length > 256) {
        const entries = await Promise.all(files.filter((name) => name !== `${key}.json`).map(async (name) => ({ name, stat: await fs.lstat(path.join(cache, name)) })));
        entries.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
        await Promise.all(entries.slice(0, files.length - 256).map(({ name }) => fs.unlink(path.join(cache, name)).catch(() => {})));
      }
      return program;
    })().finally(() => pending.delete(key));
    pending.set(key, { result, controller });
    return result;
  }
  return { read, close() { closed = true; for (const { controller } of pending.values()) controller.abort(); } };
}
