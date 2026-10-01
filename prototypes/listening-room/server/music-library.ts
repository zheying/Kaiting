import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { parseFile } from "music-metadata";
import { safeRealPath } from "../../../src/server/pathSafety.js";
import { shouldTranscode, directMimeType, inferFormatGroup } from "../../../src/server/audio.js";
import snapshot from "../src/library.json" with { type: "json" };
import { buildLightingProgram, LIGHTING_PROGRAM_VERSION, type AudioFeature, type MusicCatalog, type PreparedMusic, type RealMusicTrack } from "../src/lighting-program.js";

type Entry = RealMusicTrack & { source: string; container: string; formatGroup: string };
const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s・·_]/g, "");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const extensions = new Set([".m4a", ".mp3", ".aac", ".flac", ".alac", ".wav", ".ogg", ".opus"]);
export async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export class MusicFailure extends Error { constructor(public status: number, message: string) { super(message); } }

export function createMusicLibrary(root: string, dataDir: string) {
  if (root) {
    const inside = path.relative(path.resolve(root), path.resolve(dataDir));
    if (!inside || (!inside.startsWith(`..${path.sep}`) && inside !== ".." && !path.isAbsolute(inside))) throw new MusicFailure(400, "原型缓存目录必须在音乐目录之外。");
  }
  let catalogPromise: Promise<MusicCatalog> | null = null;
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<PreparedMusic>>();
  const prepared = new Map<string, { key: string; result: PreparedMusic; playback: string; mime: string }>();
  let unavailable = 0;
  function assertCacheOutsideMusic() {
    // 验证尚未创建的缓存路径时，先解析其已有祖先，避免别名指回曲库。
    let ancestor = path.resolve(dataDir);
    const suffix: string[] = [];
    while (!fs.existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
    const realData = path.join(fs.realpathSync.native(ancestor), ...suffix);
    const relative = path.relative(fs.realpathSync.native(root), realData);
    if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new MusicFailure(400, "原型缓存目录必须在音乐目录之外。");
  }
  async function catalog(): Promise<MusicCatalog> {
    if (!root) return { enabled: false, tracks: [], unmatched: 0, unavailable: 0 };
    if (catalogPromise) return catalogPromise;
    catalogPromise = (async () => {
      const files: string[] = [];
      const walk = async (dir: string) => {
        for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
          if (item.name.startsWith(".") || item.isSymbolicLink()) continue;
          const file = safeRealPath(root, path.join(dir, item.name));
          if (item.isDirectory()) await walk(file);
          else if (item.isFile() && extensions.has(path.extname(item.name).toLowerCase())) files.push(file);
          if (files.length > 20_000) throw new MusicFailure(413, "原型曲目数量超出读取范围。");
        }
      };
      await walk(safeRealPath(root, root));
      const byIdentity = new Map<string, { source: string; title: string; artist: string; album: string; duration: number; codec: string; container: string; disc: number | null; number: number | null }[]>();
      let cursor = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (cursor < files.length) {
          const source = files[cursor++];
          try {
            const m = await parseFile(source, { skipCovers: true });
            if (!m.common.title || !m.common.album || !m.format.duration) { unavailable++; continue; }
            const record = { source, title: m.common.title, artist: m.common.artist ?? "未知艺人", album: m.common.album, duration: m.format.duration, codec: m.format.codec ?? "", container: m.format.container ?? "", disc: m.common.disk.no, number: m.common.track.no };
            const key = `${normalize(record.album)}\n${normalize(record.title)}`;
            byIdentity.set(key, [...(byIdentity.get(key) ?? []), record]);
          } catch { unavailable++; }
        }
      }));
      const albums = new Map(snapshot.albums.map((a) => [a.id, a.title]));
      for (const track of snapshot.tracks) {
        const matches = (byIdentity.get(`${normalize(albums.get(track.albumId) ?? "")}\n${normalize(track.title)}`) ?? []).filter((m) => Math.abs(m.duration - track.duration) < 2 && (!m.disc || m.disc === track.disc) && (!m.number || m.number === track.number));
        if (matches.length !== 1) continue;
        const m = matches[0], formatGroup = inferFormatGroup(m.source, m.codec, m.container);
        entries.set(track.id, { id: track.id, title: m.title, artist: m.artist, album: m.album, duration: m.duration, codec: m.codec, format: formatGroup.toUpperCase(), source: m.source, container: m.container, formatGroup });
      }
      return { enabled: true, tracks: [...entries.values()].map(publicTrack), unmatched: snapshot.tracks.length - entries.size, unavailable };
    })().catch((error) => { catalogPromise = null; throw error instanceof MusicFailure ? error : new MusicFailure(503, "真实曲库暂时不可读，请检查挂载后重试。"); });
    return catalogPromise;
  }
  const publicTrack = ({ id, title, artist, album, duration, codec, format }: Entry): RealMusicTrack => ({ id, title, artist, album, duration, codec, format });
  async function source(id: string) {
    await catalog();
    const entry = entries.get(id);
    if (!entry) throw new MusicFailure(404, "这首曲目没有唯一匹配的真实录音。");
    try {
      const file = safeRealPath(root, entry.source), stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error("not a file");
      return { entry, file, stat, key: digest(`${file}\n${stat.size}\n${stat.mtimeMs}\n${stat.ino}\nv2`) };
    } catch { throw new MusicFailure(404, "这首曲目的文件暂时不可用。"); }
  }
  async function runFfmpeg(args: string[], consume?: (chunk: Buffer) => void) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", consume ? "pipe" : "ignore", "pipe"] });
      let finished = false;
      const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new MusicFailure(504, "音频准备超时，请稍后重试。")); }, 120_000);
      child.stdout?.on("data", consume ?? (() => {}));
      child.stderr?.resume();
      child.once("error", () => finish(new MusicFailure(503, "音频处理工具不可用。")));
      child.once("close", (code) => finish(code === 0 ? undefined : new MusicFailure(422, "这首音频暂时无法解码。")));
    });
  }
  async function analyze(file: string, duration: number) {
    const frames: AudioFeature[] = [];
    const sampleRate = 12_000, frameSize = 1200;
    const lowRate = 1 - Math.exp(-2 * Math.PI * 180 / sampleRate), highRate = 1 - Math.exp(-2 * Math.PI * 2200 / sampleRate);
    let low = 0, lowHigh = 0, sum = 0, bassSum = 0, trebleSum = 0, count = 0, previousRms = 0, previousBass = 0, fluxMean = .001, lastOnset = -1;
    let tail: Buffer = Buffer.alloc(0);
    await runFfmpeg(["-i", file, "-map", "0:a:0", "-vn", "-t", "2700", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "pipe:1"], (chunk) => {
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
    if (!frames.length) throw new MusicFailure(422, "音频没有可分析的声音。");
    return buildLightingProgram(frames, Math.min(duration, frames.length / 10));
  }
  async function trimCache(keep: string) {
    const files = (await fsp.readdir(dataDir)).filter((name) => /^[a-f0-9]{64}\.(m4a|json)$/.test(name));
    const stats = await Promise.all(files.map(async (name) => ({ name, stat: await fsp.stat(path.join(dataDir, name)) })));
    stats.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    let bytes = stats.reduce((total, item) => total + item.stat.size, 0), remaining = stats.length;
    for (const item of stats) {
      if (bytes <= 512 * 1024 * 1024 && remaining <= 48) break;
      if (item.name.startsWith(keep)) continue;
      await fsp.unlink(path.join(dataDir, item.name)).catch(() => {}); bytes -= item.stat.size; remaining--;
    }
  }
  async function prepare(id: string): Promise<PreparedMusic> {
    if (pending.has(id)) return pending.get(id)!;
    if (pending.size >= 2) throw new MusicFailure(503, "正在准备其他曲目，请稍后重试。");
    const task = (async () => {
      const item = await source(id), previous = prepared.get(id);
      if (item.entry.duration > 2700) throw new MusicFailure(413, "原型暂不支持超过 45 分钟的单曲。");
      if (previous?.key === item.key && (!previous.result.program || previous.result.program.version === LIGHTING_PROGRAM_VERSION) && fs.existsSync(previous.playback)) return previous.result;
      assertCacheOutsideMusic();
      await fsp.mkdir(dataDir, { recursive: true });
      const trackShape = { path: item.file, codec: item.entry.codec, container: item.entry.container, formatGroup: item.entry.formatGroup };
      const transcode = shouldTranscode(trackShape);
      const playback = transcode ? path.join(dataDir, `${item.key}.m4a`) : item.file;
      const metadata = path.join(dataDir, `${item.key}.json`);
      let result: PreparedMusic | null = null;
      if (fs.existsSync(metadata) && fs.existsSync(playback)) {
        try {
          const cached = JSON.parse(await fsp.readFile(metadata, "utf8")) as PreparedMusic;
          if (cached.track?.id === id && cached.program?.version === LIGHTING_PROGRAM_VERSION) result = cached;
        } catch { /* 不完整缓存重新生成。 */ }
      }
      if (!result) {
        const before = await fileHash(item.file);
        const temporary = path.join(dataDir, `${item.key}.${randomUUID()}.m4a`);
        try {
          if (transcode && !fs.existsSync(playback)) {
            await runFfmpeg(["-i", item.file, "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", "-t", "2700", "-y", temporary]);
            await fsp.rename(temporary, playback);
          }
          let program = null, analysisError: string | undefined;
          try { program = await analyze(item.file, item.entry.duration); } catch { analysisError = "本曲分析暂未完成，灯光正实时跟随声音。"; }
          const after = await fileHash(item.file);
          await fsp.appendFile(path.join(dataDir, "source-audit.ndjson"), JSON.stringify({ id, sourceHashBefore: before, sourceHashAfter: after, unchanged: before === after, at: new Date().toISOString() }) + "\n");
          if (before !== after) throw new MusicFailure(409, "准备期间音源发生变化，请重试。");
          result = { track: publicTrack(item.entry), url: `/__prototype/music/audio/${id}?v=${item.key.slice(0, 16)}`, program, analysisError, sourceHash: before };
          const metaTemp = `${metadata}.${randomUUID()}.tmp`;
          await fsp.writeFile(metaTemp, JSON.stringify(result)); await fsp.rename(metaTemp, metadata);
        } finally { await fsp.unlink(temporary).catch(() => {}); }
      }
      prepared.set(id, { key: item.key, result, playback, mime: transcode ? "audio/mp4" : directMimeType(trackShape) ?? "application/octet-stream" });
      await trimCache(item.key);
      return result;
    })().finally(() => pending.delete(id));
    pending.set(id, task); return task;
  }
  async function audio(id: string) {
    const item = await source(id);
    const cached = prepared.get(id);
    if (!cached || cached.key !== item.key || !fs.existsSync(cached.playback)) await prepare(id);
    const ready = prepared.get(id)!;
    const file = safeRealPath(ready.playback === item.file ? root : dataDir, ready.playback);
    return { file, mime: ready.mime, size: (await fsp.stat(file)).size };
  }
  return { catalog, prepare, audio, source };
}
