import fs from "node:fs";
import path from "node:path";
import { build } from "vite";
import { chromium } from "@playwright/test";
import { checkE2EBrowser } from "./e2e-browser.mjs";

// 隔离绘制与合成开销；输入是固定灯光信号，不作为真实音频播放验收。
const output = "artifacts/atmosphere-rendering";
await checkE2EBrowser({ reportDirectory: output });
const bundle = await build({ configFile: false, logLevel: "error", build: {
  write: false, minify: false, lib: { entry: "src/client/room/atmosphere-scene.ts", name: "Scene", formats: ["iife"] }
} });
const script = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((result) => result.output).find((item) => item.type === "chunk").code;
const css = ["styles.css", "now-playing.css", "atmosphere.css"].map((file) => fs.readFileSync(`src/client/room/${file}`, "utf8")).join("\n");
const results = [];
const variants = [
  { name: "canvas-only", bare: true },
  { name: "dialog" },
  { name: "dialog-without-nav-blur", css: ".av-theme-nav { backdrop-filter: none; }" },
  { name: "dialog-without-retained-animation", css: ".now-playing-dialog[open] { animation: none; transform: none; }" },
  { name: "dialog-without-both", css: ".av-theme-nav { backdrop-filter: none; } .now-playing-dialog[open] { animation: none; transform: none; }" }
];
const browser = await chromium.launch({ channel: "chromium", timeout: 20_000,
  ...(process.env.E2E_SOFTWARE_RENDERING === "1" ? { args: ["--use-angle=swiftshader"] } : {}) });
try {
  for (const variant of variants) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference" });
    try {
      const canvas = '<div class="av-visual"><canvas id="base"></canvas><canvas id="light"></canvas></div>';
      await page.setContent(`<style>${css}\nbody { margin: 0; } ${variant.css ?? ""}</style>${variant.bare ? canvas : `<dialog class="now-playing-dialog"><section class="atmosphere-mode">${canvas}<div class="av-shade"></div><div class="av-theme-nav"><button>跟随音乐</button><button>灯光编排</button><button>选曲</button></div><footer class="av-footer"><div class="av-now"><h1>渲染诊断</h1><p>固定信号，不作为播放验收</p></div><button class="av-play">Ⅱ</button></footer></section></dialog>`}`);
      await page.addScriptTag({ content: script });
      const measurements = await page.evaluate(async () => {
        document.querySelector("dialog")?.showModal();
        const base = document.querySelector("#base"), light = document.querySelector("#light");
        const scene = Scene.createAtmosphereScene(base, light, () => ({ energy: .2, bass: .2, middle: .1, treble: .1,
          pulse: 0, lowPulse: 0, epoch: 0, position: 0, spectrum: new Float32Array(96), waveform: new Float32Array(128) }), () => {}, () => {});
        const gl = light.getContext("webgl"), info = gl.getExtension("WEBGL_debug_renderer_info");
        const pixel = new Uint8Array(4);
        const flush = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        scene.update({ theme: "lattice", palette: "aurora", vivid: true, playing: false });
        flush();
        const draws = [];
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          scene.update({ theme: "lattice", palette: "aurora", vivid: true, playing: false });
          flush(); draws.push(performance.now() - start);
        }
        scene.update({ theme: "lattice", palette: "aurora", vivid: true, playing: true });
        const frames = []; let previous = performance.now(), frame;
        function sample() { const now = performance.now(); frames.push(now - previous); previous = now; frame = requestAnimationFrame(sample); }
        frame = requestAnimationFrame(sample);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        cancelAnimationFrame(frame); scene.dispose();
        const sorted = frames.slice(3).sort((a, b) => a - b);
        return { renderer: String(gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)),
          concurrency: navigator.hardwareConcurrency, pixels: light.width * light.height, draws,
          count: frames.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], frames };
      });
      results.push({ variant: variant.name, ...measurements });
      const { frames, ...summary } = results.at(-1);
      console.log("绘制合成诊断", JSON.stringify(summary));
      fs.writeFileSync(path.join(output, "measurements.json"), JSON.stringify(results, null, 2) + "\n");
      await page.screenshot({ path: path.join(output, `${variant.name}.png`) });
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
