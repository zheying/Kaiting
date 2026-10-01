import type { SoundFrame } from "./atmosphere-audio";

import { lightingLooks, type LightingLook, type LightingTheme } from "./lighting-program";
export type AtmosphereTheme = LightingTheme;
export type AtmospherePalette = "aurora" | "ember" | "silver";
export type SceneOptions = { theme: AtmosphereTheme; palette: AtmospherePalette; vivid: boolean; playing: boolean };
export const palettes = {
  aurora: { a: [255, 245, 224], b: [255, 122, 34] },
  ember: { a: [255, 242, 220], b: [210, 36, 25] },
  silver: { a: [240, 246, 255], b: [48, 90, 175] }
} as const;
type Vec3 = [number, number, number];
type Fixture = { readonly origin: Readonly<Vec3>; direction: Vec3; angle: number; intensity: number; tint: number; wash: number };
// 灯具的安装位置属于舞台，所有编排共用；模式只能控制灯头，不能重排灯位。
const fixtureMounts: readonly Readonly<Vec3>[] = [
  ...Array.from({ length: 8 }, (_, i): Vec3 => [(i - 3.5) * 1.05, .16, -7]),
  ...Array.from({ length: 8 }, (_, i): Vec3 => [(i % 4 - 1.5) * 2.15, 4.35, -2.2 - Math.floor(i / 4) * 3.1]),
  ...Array.from({ length: 4 }, (_, i): Vec3 => [(i % 2 ? 1 : -1) * 4.4, 1.5 + Math.floor(i / 2) * 1.3, -1.8 - Math.floor(i / 2) * 3.6]),
  ...Array.from({ length: 4 }, (_, i): Vec3 => [(i % 2 ? 1 : -1) * 3.5, 3.6 - Math.floor(i / 2) * 2, -7.4])
];
const lightCount = fixtureMounts.length;
const random = (n: number) => { const value = Math.sin(n * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };
const rgba = (color: readonly number[], alpha: number) => `rgba(${color.join(",")},${Math.min(1, Math.max(0, alpha))})`;
const mix = (a: readonly number[], b: readonly number[], t: number) => a.map((n, i) => Math.round(n + (b[i] - n) * t));

const fragment = `
precision highp float;
uniform vec2 resolution;
uniform float time;
uniform vec4 sources[24];
uniform vec4 directions[24];
uniform vec4 tints[24];
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1.)), f.x), f.y);
}
float haze(vec3 p) {
  vec2 drift = vec2(p.x * .55 + p.y * .21 - time * .035, p.z * .42 + p.y * .13 + time * .025);
  float cloud = noise(drift) * .72 + noise(drift * 2.7 + 4.1) * .28;
  return (.036 + cloud * .065) * exp(-max(p.y, 0.) * .18);
}
float cone(vec3 p, vec4 source, vec4 direction, float wash) {
  vec3 offset = p - source.xyz;
  float along = dot(offset, direction.xyz);
  float radius = .035 + max(0., along) * direction.w;
  float distance2 = max(0., dot(offset, offset) - along * along);
  float radial = distance2 / (radius * radius);
  float core = mix(1. - smoothstep(.15, 1.15, radial) + exp(-radial * 16.) * .25, exp(-radial * 2.), wash);
  return core * smoothstep(0., .12, along) * exp(-along * .025) / (1. + along * along * .012);
}
vec3 lighting(vec3 p) {
  vec3 light = vec3(0.);
  for (int i = 0; i < 24; i++) {
    if (sources[i].w > .001) light += tints[i].rgb * sources[i].w * cone(p, sources[i], directions[i], tints[i].a);
  }
  return light;
}
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec2 p = (gl_FragCoord.xy * 2. - resolution) / min(resolution.x, resolution.y);
  vec3 eye = vec3(0., 1.9, 5.8);
  vec3 forward = normalize(vec3(0., 1.3, -3.5) - eye);
  vec3 right = normalize(cross(forward, vec3(0., 1., 0.)));
  vec3 up = cross(right, forward);
  // 窄屏调整横向投影，保持舞台里的灯具坐标不变。
  float stageSpan = min(1., resolution.x / resolution.y * 1.5);
  vec3 ray = normalize(forward * 2.15 + right * (p.x / stageSpan) + up * p.y);
  float floorDistance = ray.y < -.001 ? -eye.y / ray.y : 100.;
  float wallDistance = (-8.5 - eye.z) / ray.z;
  float limit = min(min(floorDistance, wallDistance), 22.);
  vec3 scatter = vec3(0.);
  // 围绕视线与每条灯轴最接近的位置积分，窄光束也有足够采样。
  // 固定全空间步长会漏过灯源附近的细光锥，造成条纹或颗粒。
  for (int i = 0; i < 24; i++) {
    if (sources[i].w < .001) continue;
    vec3 offset = eye - sources[i].xyz;
    float alignment = dot(ray, directions[i].xyz);
    float denominator = max(.004, 1. - alignment * alignment);
    float center = (alignment * dot(offset, directions[i].xyz) - dot(offset, ray)) / denominator;
    center = clamp(center, 0., limit);
    float along = dot(offset + ray * center, directions[i].xyz);
    float radius = .035 + max(0., along) * directions[i].w;
    float span = min(12., radius * 2.2 / sqrt(denominator));
    float near = max(0., center - span), far = min(limit, center + span);
    if (tints[i].a > .5) {
      // 宽幅铺光采用解析雾层，额外灯组不增加逐步体积采样。
      vec3 world = eye + ray * center;
      float density = haze(world);
      scatter += tints[i].rgb * sources[i].w * cone(world, sources[i], directions[i], 1.) * density * (far - near) * .28 * exp(-density * center * .35);
      continue;
    }
    float stepSize = (far - near) / 5.;
    for (int step = 0; step < 5; step++) {
      float distance = near + (float(step) + .5) * stepSize;
      vec3 world = eye + ray * distance;
      float density = haze(world);
      float transmission = exp(-density * distance * .35);
      scatter += tints[i].rgb * sources[i].w * cone(world, sources[i], directions[i], 0.) * density * stepSize * transmission;
    }
  }
  float transmission = exp(-haze(eye + ray * limit * .5) * limit * .35);
  vec3 surface = vec3(.007, .008, .011);
  if (floorDistance < wallDistance && floorDistance < 22.) {
    vec3 floorPoint = eye + ray * floorDistance;
    surface += lighting(floorPoint + vec3(0., .012, 0.)) * .3;
    // 磨亮的深色舞台接住光斑，也保留灯源的柔和倒影。
    for (int i = 0; i < 24; i++) {
      vec3 mirror = vec3(sources[i].x, -sources[i].y, sources[i].z);
      float reflection = pow(max(0., dot(ray, normalize(mirror - eye))), 180.);
      surface += tints[i].rgb * sources[i].w * reflection * .14;
    }
    surface *= .6 + .4 * exp(-length(floorPoint.xz) * .07);
  } else {
    vec3 wallPoint = eye + ray * wallDistance;
    surface += lighting(wallPoint) * .07;
  }
  vec3 color = scatter * 4.5 + surface * transmission;
  for (int i = 0; i < 24; i++) {
    vec3 toSource = sources[i].xyz - eye;
    float alignment = max(0., dot(ray, normalize(toSource)));
    float visible = length(toSource) < limit + .15 ? 1. : 0.;
    float core = pow(alignment, 100000.);
    float bloom = pow(alignment, 2500.);
    float halo = pow(alignment, 220.);
    float facing = max(0., dot(directions[i].xyz, normalize(-toSource)));
    color += tints[i].rgb * sources[i].w * (core * 2.2 + bloom * .04 + halo * .007) * (1. + facing * facing * 1.5) * visible * (1. - tints[i].a * .65);
  }
  float vignette = 1. - smoothstep(.32, .9, length(uv - .5));
  color *= .72 + vignette * .28;
  color = 1. - exp(-color * 1.65);
  color += vec3((hash(gl_FragCoord.xy) - .5) * .0025);
  gl_FragColor = vec4(max(color, vec3(0.)), 1.);
}`;

function createStage(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, powerPreference: "low-power" });
  if (!gl) return null;
  let vertex: WebGLShader | null = null, pixel: WebGLShader | null = null;
  let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null;
  const shader = (type: number, code: string) => {
    const handle = gl.createShader(type);
    if (!handle) throw new Error("无法创建灯光画面");
    gl.shaderSource(handle, code); gl.compileShader(handle);
    if (!gl.getShaderParameter(handle, gl.COMPILE_STATUS)) { gl.deleteShader(handle); throw new Error("灯光着色器不可用"); }
    return handle;
  };
  try {
    vertex = shader(gl.VERTEX_SHADER, "attribute vec2 point; void main() { gl_Position = vec4(point, 0., 1.); }");
    pixel = shader(gl.FRAGMENT_SHADER, fragment);
    program = gl.createProgram();
    if (!program) throw new Error("灯光画面不可用");
    gl.attachShader(program, vertex); gl.attachShader(program, pixel); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("灯光画面不可用");
    gl.useProgram(program);
    buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const point = gl.getAttribLocation(program, "point");
    gl.enableVertexAttribArray(point); gl.vertexAttribPointer(point, 2, gl.FLOAT, false, 0, 0);
    const resolution = gl.getUniformLocation(program, "resolution"), clock = gl.getUniformLocation(program, "time");
    const source = gl.getUniformLocation(program, "sources[0]"), direction = gl.getUniformLocation(program, "directions[0]"), tint = gl.getUniformLocation(program, "tints[0]");
    const origins = new Float32Array(lightCount * 4), directions = new Float32Array(lightCount * 4), tints = new Float32Array(lightCount * 4);
    return {
      draw(time: number, fixtures: Fixture[], palette: AtmospherePalette) {
        const colors = palettes[palette];
        origins.fill(0); directions.fill(0); tints.fill(0);
        fixtures.forEach((fixture, i) => {
          origins.set([...fixture.origin, fixture.intensity], i * 4);
          directions.set([...fixture.direction, fixture.angle], i * 4);
          tints.set([...mix(colors.a, colors.b, fixture.tint).map((n) => n / 255), fixture.wash], i * 4);
        });
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(resolution, canvas.width, canvas.height); gl.uniform1f(clock, time);
        gl.uniform4fv(source, origins); gl.uniform4fv(direction, directions); gl.uniform4fv(tint, tints);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },
      dispose() { gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(pixel); }
    };
  } catch {
    gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(pixel);
    return null;
  }
}

export function createAtmosphereScene(canvas: HTMLCanvasElement, lightCanvas: HTMLCanvasElement, readSound: () => SoundFrame, onFallback: (fallback: boolean) => void, onLook: (look: LightingLook) => void) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("这个浏览器暂时无法绘制氛围画面。");
  const ctx = context;
  let stage = createStage(lightCanvas);
  let options: SceneOptions = { theme: "auto", palette: "aurora", vivid: true, playing: false };
  let width = 0, height = 0, ratio = 1, frame = 0, time = 0, previous = 0, settling = 0;
  let level = .2, accent = 0, lowAccent = 0, beatCount = 0, soundEpoch = -1, lastLookChange = -10, average = .2;
  let selected: LightingLook = "spotlight";
  const weights = lightingLooks.map((_, i) => i === 0 ? 1 : 0);
  const onsets: number[] = [];
  let disposed = false, contextLost = false;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function size() {
    const rect = canvas.parentElement!.getBoundingClientRect();
    const nextWidth = Math.round(rect.width), nextHeight = Math.round(rect.height);
    // 体积光的分辨率单独限制，避免大屏幕和高 DPR 放大逐像素采样成本。
    const budget = nextWidth < 600 ? 400_000 : 550_000;
    const nextRatio = Math.min(window.devicePixelRatio || 1, 1.4, Math.sqrt(budget / Math.max(1, nextWidth * nextHeight)));
    if (width === nextWidth && height === nextHeight && ratio === nextRatio) return;
    width = nextWidth; height = nextHeight; ratio = nextRatio;
    canvas.width = lightCanvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = lightCanvas.height = Math.max(1, Math.round(height * ratio));
    draw();
  }
  function select(look: LightingLook) {
    if (selected !== look) { selected = look; lastLookChange = time; onLook(look); }
  }
  function fixtures(): Fixture[] {
    const force = options.vivid ? 1 : .35;
    // 留出拍间的暗部，重拍由独立的短包络驱动，避免一直高亮吞掉起落。
    const strength = .9 + level * 3.8;
    const sway = Math.sin(time * .28) * force;
    const sweep = Math.sin(time * .3) * force;
    const breath = .5 + .5 * Math.sin(time * .32);
    const chase = (phase: number) => .12 + .88 * Math.pow(.5 + .5 * Math.cos(time * (1.1 + level) - phase + beatCount * .18), 3);
    const layout = (look: LightingLook): Fixture[] => {
      const result: Fixture[] = [];
      const response = ["afterglow", "stars", "duet", "spotlight"].includes(look) ? .18 : ["rain", "curtain", "canopy"].includes(look) ? .5 : 1;
      const punch = accent * force * response, thump = lowAccent * force * response;
      const add = (target: Vec3, angle: number, gain: number, tint: number, wash = false) => {
        const index = result.length, origin = fixtureMounts[index];
        const vector = target.map((n, i) => n - origin[i]) as Vec3;
        const length = Math.max(.001, Math.hypot(...vector));
        const output = look === "afterglow" ? .35 + level * .45 : strength * (look === "burst" ? .4 : 1);
        // 低频起音强调后排，清脆起音强调交替顶灯和侧灯。灯位与灯头轨迹保持连续。
        const alternate = index % 2 === beatCount % 2 ? 1 : .28;
        const strike = index < 8 ? thump * .9 + punch * .35 : index < 16 ? punch * (.55 + alternate * .65) : punch * .9;
        const intensity = wash ? output * gain * (1 - punch * .22) : gain * (output + strike * (6.5 + level * 2));
        result.push({ origin, direction: vector.map((n) => n / length) as Vec3,
          angle: angle * (wash ? 1 : 1 - Math.min(.32, strike * .28)), intensity,
          tint: tint * (wash ? 1 : 1 - Math.min(.5, strike * .35)), wash: wash ? 1 : 0 });
      };
      for (let i = 0; i < 8; i++) {
        const x = (i - 3.5) * 1.05;
        let target: Vec3 = [x * 1.6, 4.6, -.5];
        let gain = .25, angle = .035, tint = i % 2 ? .95 : .06;
        switch (look) {
          case "spotlight": gain = 0; break;
          case "curtain": target = [x, 4.8, -6.4]; angle = .014; gain = .8; tint = .35; break;
          case "geometry": target = [-x * .9 + sway, 2.5, -1]; gain = .3; break;
          case "particles": target = [x * (1.35 + level), 3.5 + level * 2, .5]; gain = 1.25; angle = .045; break;
          case "fluid": target = [x * .65 + sway, 3.4, -2]; gain = chase(i * .8) * 1.25; break;
          case "canopy": target = [x * .55, 4.4, -2]; gain = .35; angle = .09; tint = .85; break;
          case "wings": target = [x * 2.2, 2.6, 0]; gain = .4 + .35 * Math.sin(time * .7 + (i < 4 ? 0 : Math.PI)); break;
          case "wave": target = [x * 1.25, 1.6 + Math.sin(time * .7 - i * .3) * .8, 2]; gain = chase(i * .4) * 1.1; angle = .065; break;
          case "orbit": target = [x + Math.sin(time * .4 + i * .78) * 2, 2.7 + Math.cos(time * .4 + i * .78) * 1.4, -1]; gain = .65; angle = .022; break;
          case "stars": target = [x, 3.5, -6.5]; angle = .009; gain = i % 3 === 1 ? .07 : 0; tint = .12; break;
          case "tunnel": target = [-x * .7, 3.2, -2.3]; gain = .4 + chase(i * .6) * .35; angle = .025; break;
          case "burst": target = [x * 2, 4.5 + Math.abs(x) * .2, 2.5]; gain = 1.3; angle = .052; tint = i % 3 ? .07 : .9; break;
          case "duet": gain = 0; break;
          case "rain": target = [x, 4.5, -6.5]; gain = .04; angle = .012; tint = .7; break;
          case "afterglow": target = [x * .5, 2.8, -6.5]; gain = .11; angle = .5; tint = .85; break;
          case "horizon": target = [x * 1.55, .35 + sway * .15, 2]; gain = .6; angle = .022; tint = .8; break;
          case "lattice": target = [x + (i % 2 ? -2.9 : 2.9) + sway * .2, 4.3, -2]; gain = .85; angle = .012; tint = i % 2 ? .88 : .1; break;
          case "searchlights": target = [x + (i < 4 ? -1 : 1) * sweep * 3.2, 4.8, -1]; gain = .95; angle = .028; tint = i < 4 ? .08 : .78; break;
        }
        add(target, angle, gain, tint, look === "afterglow");
      }
      for (let i = 0; i < 8; i++) {
        const column = i % 4, row = Math.floor(i / 4), x = (column - 1.5) * 2.15;
        const origin = fixtureMounts[8 + i];
        let target: Vec3 = [x, 0, -1 - row * 2];
        let gain = .25, angle = .038, tint = row ? .92 : .02;
        switch (look) {
          case "spotlight": target = [sway * .45, 0, -.8]; gain = i === 1 ? 1.7 : 0; angle = .075; tint = .12; break;
          case "curtain": target = [x, 0, origin[2]]; gain = .65; angle = .018; tint = .15; break;
          case "geometry": target = [-x * 1.1 + sway, .3, -.5 - row * 2]; gain = .35; break;
          case "particles": target = [x * .15, 0, -4]; gain = .13; angle = .018; break;
          case "fluid": target = [x + Math.sin(time * .65 + column) * 1.7 * force, 0, -1 - row]; gain = .2 + chase(column * 1.6 + row * 2) * 1.3; angle = .04; break;
          case "canopy": target = [-x * 1.3, 2.4 + Math.sin(time * .3 + column) * .3, -row * 2]; gain = 1; angle = .04; break;
          case "wings": target = [x * .3, 0, -3]; gain = .15; break;
          case "wave": target = [x, 0, 1 + Math.sin(time * .65 - row * 1.6) * 2]; gain = .25 + chase(row * 2.5 + column * .35); angle = .07; break;
          case "orbit": target = [Math.cos(time * .4 + i * Math.PI / 4) * 2.6, 0, -2.7 + Math.sin(time * .4 + i * Math.PI / 4) * 2.6]; gain = .75; angle = .024; tint = .2; break;
          case "stars": target = [x, 0, origin[2]]; gain = .16 + chase(i * 2) * .22; angle = .008; tint = .07; break;
          case "tunnel": target = [-x, 0, origin[2] + 2.2]; gain = .5 + chase(row * 2 + column * .8) * .5; angle = .022; break;
          case "burst": target = [x * .6 + sway * .5, 1, 2.3]; gain = 1.1; angle = .048; tint = .1; break;
          case "duet": target = [(column < 2 ? -1 : 1) * (1.5 + sweep * .6), 0, -1.8]; gain = i === 1 || i === 2 ? 1.15 : 0; angle = .075; tint = i === 1 ? .12 : .55; break;
          case "rain": target = [x - 2.1 + sway * .25, 0, origin[2] + 1.2]; gain = .28 + chase(i * 1.1) * .75; angle = .012; tint = .3 + row * .25; break;
          case "afterglow": target = [x * .4, 1.4, -5.8]; gain = .08; angle = .5; tint = .75; break;
          case "horizon": gain = 0; break;
          case "lattice": target = [x + (column % 2 ? -3.2 : 3.2) - sway * .2, 0, -2 - row * 2]; gain = .8; angle = .012; tint = row ? .82 : .1; break;
          case "searchlights": target = [x - sweep * 3.2, 1, 1]; gain = row ? .65 : 0; angle = .028; tint = .15; break;
        }
        add(target, angle, gain, tint, look === "afterglow");
      }
      for (let i = 0; i < 4; i++) {
        const side = i % 2 ? 1 : -1, row = Math.floor(i / 2);
        let target: Vec3 = [-side * 3.4, .6, -1.5 + row], gain = .2, angle = .04;
        if (look === "geometry") { target = [-side * (3 + sway), .6 + row * 1.2, -2 + row]; gain = 1.4; }
        else if (look === "wings") { target = [-side * (1.7 + level), 2.5 + Math.sin(time * .65) * .8, -1]; gain = .35 + (side * Math.sin(time * .8) * .5 + .5) * 1.4; angle = .065; }
        else if (look === "burst") { target = [-side * 2.5, 2.8, 3]; gain = 1.05; angle = .06; }
        else if (look === "wave") { target = [-side, .3, 1.5]; gain = chase(row * 2) * .7; }
        else if (look === "canopy") { target = [-side * 2, 3.8, -2]; gain = .55; }
        else if (look === "tunnel") { target = [-side * 3.1, .2, -.5 - row * 3]; gain = .65 + chase(row * 2) * .35; angle = .025; }
        else if (look === "afterglow") { target = [-side * .5, 2, -6]; gain = .18; angle = .55; }
        else if (look === "horizon") { target = [-side * 4.4, 1.5 + row * 1.3 + sway * .12, -1 - row * 3.6]; gain = .85 + breath * .2; angle = .024; }
        else if (look === "lattice") { target = [-side * 3.8, row ? .55 : 3.9, -4 + row * 2]; gain = .65; angle = .015; }
        else if (["stars", "spotlight", "particles", "curtain", "duet", "rain", "searchlights"].includes(look)) gain = 0;
        add(target, angle, gain, side > 0 ? .08 : .98, look === "afterglow");
      }
      for (let i = 0; i < 4; i++) {
        const side = i % 2 ? 1 : -1;
        const gain = ["spotlight", "stars", "duet"].includes(look) ? .025 : look === "burst" ? .4 : look === "canopy" ? .22 : look === "afterglow" ? .5 + breath * .2 : look === "horizon" || look === "rain" ? .04 : .1;
        add(look === "afterglow" ? [-side * 1.8, 2.6, -6.9] : [-side * 1.8, 1, -3.5], look === "afterglow" ? .72 : .46, gain, look === "afterglow" ? .55 + side * .2 : .9, true);
      }
      return result;
    };
    let combined: Fixture[] | null = null;
    for (let k = 0; k < weights.length; k++) {
      const weight = weights[k];
      if (weight < .001) continue;
      const lights = layout(lightingLooks[k].id);
      if (!combined) combined = lights.map((l) => ({ ...l, direction: [0, 0, 0], angle: 0, intensity: 0, tint: 0, wash: 0 }));
      lights.forEach((light, i) => {
        const output = combined![i];
        for (let j = 0; j < 3; j++) output.direction[j] += light.direction[j] * weight;
        output.angle += light.angle * weight; output.intensity += light.intensity * weight; output.tint += light.tint * weight; output.wash += light.wash * weight;
      });
    }
    return (combined ?? layout(selected)).map((light) => ({ ...light, direction: light.direction.map((n) => n / Math.max(.001, Math.hypot(...light.direction))) as Vec3 }));
  }
  function fallback(lights: Fixture[]) {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.globalAlpha = 1; ctx.filter = "none";
    ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = "#08090d"; ctx.fillRect(0, 0, width, height);
    const focal = Math.min(width, height) * 1.2;
    const span = Math.min(1, width / Math.max(1, height) * 1.5);
    const project = ([x, y, z]: Readonly<Vec3>) => [width * .5 + x * span * focal / (5.8 - z), height * .48 - (y - 1.7) * focal / (5.8 - z)];
    const glow = (x: number, y: number, radius: number, color: number[], alpha: number) => {
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, radius));
      gradient.addColorStop(0, rgba(color, alpha)); gradient.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = gradient; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    };
    const palette = palettes[options.palette];
    ctx.globalCompositeOperation = "screen"; ctx.filter = "blur(2px)";
    for (const light of lights) {
      const { origin, direction, angle } = light;
      const color = mix(palette.a, palette.b, light.tint);
      const distance = direction[1] < -.01 ? Math.min(12, -origin[1] / direction[1]) : 7;
      const end = origin.map((n, i) => n + direction[i] * distance) as Vec3;
      const source = project(origin), target = project(end);
      const radius = distance * angle * focal / Math.max(2, 5.8 - end[2]);
      const length = Math.hypot(target[0] - source[0], target[1] - source[1]);
      const normal = [-(target[1] - source[1]) / Math.max(1, length), (target[0] - source[0]) / Math.max(1, length)];
      for (let band = 3; band > 0; band--) {
        const spread = radius * (.45 + band * .35);
        const wash = ctx.createLinearGradient(source[0], source[1], target[0], target[1]);
        const strength = .25 - light.wash * .17;
        wash.addColorStop(0, rgba(color, .18 * light.intensity * strength / band)); wash.addColorStop(.6, rgba(color, .085 * light.intensity * strength / band)); wash.addColorStop(1, rgba(color, .025 * light.intensity * strength / band));
        ctx.beginPath(); ctx.moveTo(source[0] - normal[0], source[1] - normal[1]);
        ctx.lineTo(target[0] - normal[0] * spread, target[1] - normal[1] * spread);
        ctx.lineTo(target[0] + normal[0] * spread, target[1] + normal[1] * spread);
        ctx.lineTo(source[0] + normal[0], source[1] + normal[1]); ctx.closePath(); ctx.fillStyle = wash; ctx.fill();
      }
      glow(source[0], source[1], 16 + light.wash * 12, color, .3 * light.intensity);
      ctx.save(); ctx.translate(target[0], target[1]); ctx.scale(1, .25);
      glow(0, 0, radius * 2.5, color, .22 * light.intensity); ctx.restore();
    }
    ctx.filter = "none";
    for (let i = 0; i < 140; i++) {
      const x = random(i + 37) * width + Math.sin(time * .1 + i) * 8;
      const y = random(i + 94) * height;
      ctx.fillStyle = rgba(palette.a, .035); ctx.fillRect(x, y, .8, .8);
    }
    ctx.globalCompositeOperation = "source-over";
  }
  function draw() {
    if (!width || !height || disposed || document.hidden) return;
    const useStage = Boolean(stage && !contextLost);
    lightCanvas.hidden = !useStage; canvas.hidden = useStage;
    const lights = fixtures();
    if (useStage) stage!.draw(time, lights, options.palette); else fallback(lights);
  }
  function tick(now: number) {
    frame = 0;
    if (disposed || document.hidden) return;
    const elapsed = previous ? (now - previous) / 1000 : 0;
    const delta = Math.min(.05, elapsed);
    previous = now;
    const target = readSound();
    if (soundEpoch !== target.epoch) {
      soundEpoch = target.epoch; accent = lowAccent = 0; beatCount = 0; onsets.length = 0;
      level = average = target.energy;
    }
    const gain = target.energy > level ? 2.8 : .9;
    level += (target.energy - level) * (1 - Math.exp(-delta * gain));
    // 快起、快落；使用实际帧间隔，不让舞台慢速运动时钟拖慢鼓点。
    accent = Math.max(accent * Math.exp(-elapsed * (options.vivid ? 15 : 8)), target.pulse);
    lowAccent = Math.max(lowAccent * Math.exp(-elapsed * (options.vivid ? 12 : 7)), target.lowPulse);
    if (options.playing && target.pulse > 0) { beatCount++; onsets.push(now / 1000); }
    while (onsets.length && onsets[0] < now / 1000 - 6) onsets.shift();
    average += (target.energy - average) * (1 - Math.exp(-delta * .18));
    if (options.theme === "auto" && options.playing && time - lastLookChange > 8) {
      const density = onsets.length / 6;
      const next: LightingLook = level < .025 ? "stars" : level < .085 ? "afterglow" : level < .18 ? "duet"
        : level > average * 1.5 && level > .5 ? "searchlights" : level > .7 && density > 1.3 ? "lattice"
        : target.bass > .63 && level > .45 ? "horizon" : density > 1.6 ? "fluid"
        : target.treble > .4 ? "orbit" : level > .4 ? "canopy" : density > .7 ? "rain" : "curtain";
      select(next);
    } else if (options.theme !== "auto") select(options.theme);
    for (let i = 0; i < weights.length; i++) weights[i] += ((lightingLooks[i].id === selected ? 1 : 0) - weights[i]) * (1 - Math.exp(-delta * 2));
    if (options.playing && !motion.matches) time += delta * (.65 + level * .65);
    draw();
    if (options.playing && !motion.matches) frame = requestAnimationFrame(tick);
    else if (settling > 0 && !motion.matches) { settling -= delta; frame = requestAnimationFrame(tick); }
  }
  function resume() {
    cancelAnimationFrame(frame); frame = 0; previous = 0;
    if (disposed || document.hidden) return;
    if (motion.matches) accent = lowAccent = 0;
    draw();
    if (!motion.matches && (options.playing || settling > 0)) frame = requestAnimationFrame(tick);
  }
  function lost(event: Event) { event.preventDefault(); contextLost = true; onFallback(true); draw(); }
  function restored() { stage?.dispose(); stage = createStage(lightCanvas); contextLost = false; onFallback(!stage); resume(); }
  const observer = new ResizeObserver(size);
  observer.observe(canvas.parentElement!);
  motion.addEventListener("change", resume);
  document.addEventListener("visibilitychange", resume);
  lightCanvas.addEventListener("webglcontextlost", lost);
  lightCanvas.addEventListener("webglcontextrestored", restored);
  onFallback(!stage); size();
  return {
    update(next: SceneOptions) {
      settling = options.playing && !next.playing ? .65 : 0;
      const changed = options.theme !== next.theme;
      options = next;
      if (next.theme !== "auto") select(next.theme);
      if (changed && (!next.playing || motion.matches)) for (let i = 0; i < weights.length; i++) weights[i] = lightingLooks[i].id === selected ? 1 : 0;
      resume();
    },
    dispose() {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); stage?.dispose();
      motion.removeEventListener("change", resume); document.removeEventListener("visibilitychange", resume);
      lightCanvas.removeEventListener("webglcontextlost", lost); lightCanvas.removeEventListener("webglcontextrestored", restored);
    }
  };
}
