export const lightingLooks = [
  { id: "spotlight", name: "一束追光", description: "留一束光，跟随轻声的旋律" },
  { id: "curtain", name: "垂落光幕", description: "细密的光，从天幕慢慢垂落" },
  { id: "geometry", name: "雾中侧光", description: "两侧光束，在雾中交错" },
  { id: "particles", name: "逆光开场", description: "后排扇面，随着渐强打开" },
  { id: "fluid", name: "灯阵呼吸", description: "逐灯追逐，让重拍在空间里流动" },
  { id: "canopy", name: "穹顶漫游", description: "交织的拱顶，托住舒展的旋律" },
  { id: "wings", name: "双翼对答", description: "左右灯组，回应低频的起落" },
  { id: "wave", name: "光浪推进", description: "光从后场，一层一层涌来" },
  { id: "orbit", name: "环形游弋", description: "环绕的光束，缓缓旋转" },
  { id: "stars", name: "星点夜空", description: "稀疏的点光，留给安静的细节" },
  { id: "tunnel", name: "纵深光廊", description: "成排光束，向节奏深处延伸" },
  { id: "burst", name: "全场齐射", description: "在能量高点，打开整个舞台" },
  { id: "duet", name: "双束对望", description: "两束追光，慢慢靠近又分开" },
  { id: "rain", name: "斜落光雨", description: "斜斜落下的细光，依次亮起" },
  { id: "afterglow", name: "余晖漫场", description: "让温暖的颜色，缓缓铺满舞台" },
  { id: "horizon", name: "低空光海", description: "层层横光，贴着舞台涌来" },
  { id: "lattice", name: "交错织光", description: "细密交叉的光网，随重拍舒展" },
  { id: "searchlights", name: "探照巡游", description: "成组光柱，整齐扫过上空" },
  { id: "petals", new: true, name: "花影流转", description: "花瓣状的光影，在地面缓缓旋转" },
  { id: "windows", new: true, name: "百叶光窗", description: "光穿过百叶，在雾中留下明暗纹理" },
  { id: "fan", new: true, name: "扇屏开合", description: "两层细光扇面，随着旋律舒展" },
  { id: "relay", new: true, name: "节拍接力", description: "一次起音，一组灯光接过下一拍" }
] as const;
export const LIGHTING_PROGRAM_VERSION = 5;
export type LightingLook = typeof lightingLooks[number]["id"];
export type LightingTheme = LightingLook | "auto";
export type AudioFeature = { time: number; rms: number; bass: number; treble: number; onset: number };
export type LightingCue = { start: number; end: number; look: LightingLook; reason: string; energy: number; density: number; bass: number; brightness: number; rise: number };
export type LightingProgram = {
  version: number; duration: number; cues: LightingCue[];
  summary: { dynamicRange: number; averageDensity: number; peakRms: number; character: string };
};
export type RealMusicTrack = { id: string; title: string; artist: string; album: string; duration: number; codec: string; format: string };

const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

/** 声音特征生成灯光时间轴；不从曲名推测流派，也不标注未经识别的主歌/副歌。 */
export function buildLightingProgram(frames: AudioFeature[], duration: number): LightingProgram {
  const audible = frames.filter((f) => f.rms > .0008);
  const low = percentile(audible.map((f) => f.rms), .15);
  const high = Math.max(.003, percentile(audible.map((f) => f.rms), .9));
  const range = Math.max(high * .3, high - low);
  const averageDensity = frames.filter((f) => f.onset > .5).length / Math.max(1, duration);
  const dynamicRange = 20 * Math.log10(high / Math.max(.0001, low));
  const softRecording = high < .22 && dynamicRange > 12 && averageDensity < 1.8 && mean(audible.map((f) => f.treble)) < .18;
  const cues: LightingCue[] = [];
  let previous: LightingLook = "spotlight", holdUntil = 0;
  for (let second = 0; second < duration; second++) {
    const at = Math.min(frames.length - 1, Math.floor(second * 10));
    const local = frames.slice(Math.max(0, at - 15), Math.min(frames.length, at + 16));
    const past = frames.slice(Math.max(0, at - 70), Math.max(1, at - 20));
    const upcoming = frames.slice(at + 15, at + 55);
    const rms = mean(local.map((f) => f.rms));
    const energy = clamp((rms - low) / range);
    const density = frames.slice(Math.max(0, at - 40), at + 40).filter((f) => f.onset > .5).length / 8;
    const bass = mean(local.map((f) => f.bass)), brightness = mean(local.map((f) => f.treble));
    const rise = clamp((mean(upcoming.map((f) => f.rms)) - mean(past.map((f) => f.rms))) / high, -1, 1);
    const prior = cues[cues.length - 1];
    const contrast = prior ? Math.abs(energy - prior.energy) + Math.abs(brightness - prior.brightness) * .5 : 1;
    const quiet = rms < .0012 || energy < .13;
    let look: LightingLook, reason: string;
    if (rms < .0008) { look = "stars"; reason = "留白与尾音"; }
    else if (energy < .12 && rise < -.16) { look = "afterglow"; reason = "余音收束"; }
    else if ((quiet && density < .6) || (softRecording && energy < .4)) { look = brightness > .18 ? "stars" : second < 16 ? "duet" : energy < .1 ? "afterglow" : "windows"; reason = "轻奏留白"; }
    else if (softRecording) { look = brightness > .15 ? "orbit" : density > 1.45 ? "rain" : "petals"; reason = "旋律舒展"; }
    else if (rise > .23 && energy < .75) { look = density > 1.8 ? "searchlights" : "fan"; reason = "渐强展开"; }
    else if (energy > .76 && (density > 1.1 || rise > .16)) { look = rise > .16 ? "fan" : density > 2.4 ? "lattice" : "burst"; reason = "高能释放"; }
    else if (density > 2.0 && energy > .42) { look = density > 2.3 && bass > .45 ? "relay" : brightness > .2 ? "lattice" : brightness > .17 ? "fluid" : "tunnel"; reason = "密集节奏"; }
    else if (bass > .48 && density > .65) { look = energy > .55 && bass > .6 ? "horizon" : energy > .5 ? "wings" : "geometry"; reason = "低频回应"; }
    else if (energy > .5 && density > .9) { look = "wave"; reason = "节奏推进"; }
    else if (brightness > .2 && density < 1.1) { look = energy < .55 ? "petals" : "orbit"; reason = "明亮旋律"; }
    else if (energy > .32 && density < 1.1) { look = energy > .55 ? "windows" : "canopy"; reason = "旋律舒展"; }
    else { look = brightness < .1 ? "curtain" : "geometry"; reason = "平稳铺陈"; }
    // 同类声音长时间维持时，沿相同意图换一个构图；变化只在特征差异处发生。
    if (prior && second - prior.start > 20 && contrast > .18 && look === previous) {
      const companion: Partial<Record<LightingLook, LightingLook>> = { petals: "canopy", windows: "curtain", fan: "particles", relay: "fluid", canopy: "duet", duet: "canopy", rain: "curtain", afterglow: "stars", horizon: "wings", lattice: "fluid", searchlights: "particles", geometry: "curtain", fluid: "tunnel", wings: "geometry", wave: "particles", curtain: "stars", burst: "wave" };
      look = companion[look] ?? look;
    }
    const canChange = second >= holdUntil || (quiet && rms < .0008) || (look === "burst" && rise > .28 && second - (prior?.start ?? 0) >= 4);
    if (!prior || (look !== previous && canChange)) {
      if (prior) prior.end = second;
      cues.push({ start: second, end: duration, look, reason, energy, density, bass, brightness, rise });
      previous = look; holdUntil = second + (look === "burst" ? 6 : quiet ? 9 : 7);
    }
  }
  return { version: LIGHTING_PROGRAM_VERSION, duration, cues, summary: { dynamicRange, averageDensity, peakRms: high, character: softRecording ? "轻奏与旋律" : dynamicRange > 12 ? "起伏丰富" : averageDensity > 1.5 ? "节奏鲜明" : "旋律舒展" } };
}

export function cueAt(program: LightingProgram | null | undefined, position: number): LightingCue | null {
  if (!program?.cues.length || position < 0 || position >= program.duration) return null;
  let left = 0, right = program.cues.length - 1;
  while (left < right) { const mid = Math.ceil((left + right) / 2); if (program.cues[mid].start <= position) left = mid; else right = mid - 1; }
  return program.cues[left];
}
