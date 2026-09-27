const TAU = Math.PI * 2;
const BACKGROUND = "#080f1b";

type Wave = {
  baseline: number;
  slope: number;
  amplitude: number;
  frequency: number;
  phase: number;
  speed: number;
  spread: number;
  colors: [string, string, string];
};

const waves: Wave[] = [
  { baseline: .44, slope: -.4, amplitude: .15, frequency: 1.18, phase: .7, speed: .3, spread: .055, colors: ["#6085b2", "#e8b4a2", "#cf5976"] },
  { baseline: .61, slope: .34, amplitude: .12, frequency: 1.06, phase: 2.8, speed: -.24, spread: .07, colors: ["#d07091", "#d397ac", "#648ebe"] },
  { baseline: .49, slope: -.1, amplitude: .27, frequency: .78, phase: 4.7, speed: .19, spread: .045, colors: ["#668bb5", "#a1b8d2", "#c18caa"] }
];

function waveY(wave: Wave, x: number, strand: number, time: number, height: number, scale: number) {
  const phase = x * TAU * wave.frequency + wave.phase - time * wave.speed;
  // Every strand follows the same continuous field. The fan opens and closes
  // gradually; paths never use dash offsets, independent transforms, or random frames.
  const envelope = .7 + .3 * Math.sin(x * Math.PI);
  const fan = strand * wave.spread * (.8 + .4 * Math.cos(phase * .7));
  const fundamental = Math.sin(phase + strand * .14) * wave.amplitude;
  const harmonic = Math.sin(phase * 1.8 + time * .12) * .022;
  return height * (wave.baseline + wave.slope * (x - .5)) + scale * ((fundamental + harmonic) * envelope + fan);
}

function paintScene(context: CanvasRenderingContext2D, width: number, height: number, time: number) {
  context.globalAlpha = 1;
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, width, height);

  const scale = Math.min(height, width * .9);
  const glow = (x: number, y: number, radius: number, color: string) => {
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, `${color.slice(0, 7)}00`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  };
  // Soft light is rasterized with gradients, without live SVG/CSS filters.
  glow(width * .1, height * (.58 + Math.sin(time * .13) * .05), scale * .8, "#a3496345");
  glow(width * .87, height * (.37 + Math.cos(time * .11) * .06), scale * .85, "#477fa44a");
  glow(width * .5, height * .82, scale * .65, "#54427526");

  const steps = Math.ceil(width / 8);
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const [waveIndex, wave] of waves.entries()) {
    const ink = context.createLinearGradient(0, 0, width, 0);
    ink.addColorStop(0, wave.colors[0]);
    ink.addColorStop(.47, wave.colors[1]);
    ink.addColorStop(1, wave.colors[2]);
    context.strokeStyle = ink;

    for (let strand = -12; strand <= 12; strand += 1) {
      const offset = strand / 12;
      context.beginPath();
      for (let step = 0; step <= steps; step += 1) {
        const x = step / steps;
        const y = waveY(wave, x, offset, time, height, scale);
        if (step === 0) context.moveTo(x * width, y);
        else context.lineTo(x * width, y);
      }
      const prominence = Math.pow(1 - Math.abs(offset), 1.5);
      context.globalAlpha = (waveIndex === 0 ? .14 : .08) + prominence * .28;
      context.lineWidth = strand === 0 ? 1.4 : .7;
      context.stroke();
      if (strand === 0) {
        context.globalAlpha = .045;
        context.lineWidth = 9;
        context.stroke();
      }
    }
  }

  context.globalAlpha = 1;
  // Keep the center quiet for the translucent form without a backdrop-filter.
  glow(width * .5, height * .5, Math.max(width * .35, height * .55), "#080f1b94");
  const shade = context.createLinearGradient(0, 0, 0, height);
  shade.addColorStop(0, "#080f1b45");
  shade.addColorStop(.45, "#080f1b00");
  shade.addColorStop(1, "#080f1b55");
  context.fillStyle = shade;
  context.fillRect(0, 0, width, height);
}

export function startLoginScene(canvas: HTMLCanvasElement): (() => void) | undefined {
  const context = canvas.getContext("2d", { alpha: false });
  const buffer = document.createElement("canvas");
  const paint = buffer.getContext("2d", { alpha: false });
  if (!context || !paint) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  let previousTime: number | undefined;
  let elapsed = 0;
  let width = 0;
  let height = 0;
  let density = 1;
  let disposed = false;
  let contextLost = false;

  function draw() {
    if (!width || !height || contextLost || disposed) return;
    paint!.setTransform(density, 0, 0, density, 0, 0);
    paintScene(paint!, width, height, elapsed);
    // Finish the opaque frame off screen, then publish it in one operation.
    // The visible canvas is never cleared between animation frames.
    context!.drawImage(buffer, 0, 0);
  }

  function animate(timestamp: number) {
    frame = 0;
    if (disposed || contextLost || document.hidden || reducedMotion.matches) return;
    if (previousTime !== undefined) elapsed += Math.min((timestamp - previousTime) / 1000, .05);
    previousTime = timestamp;
    draw();
    frame = window.requestAnimationFrame(animate);
  }

  function stop() {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    previousTime = undefined;
  }

  function resume() {
    stop();
    if (disposed || contextLost || document.hidden) return;
    draw();
    if (!reducedMotion.matches) frame = window.requestAnimationFrame(animate);
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    const nextWidth = Math.round(bounds.width);
    const nextHeight = Math.round(bounds.height);
    const nextDensity = Math.min(window.devicePixelRatio || 1, 2);
    if (!nextWidth || !nextHeight || (width === nextWidth && height === nextHeight && density === nextDensity)) return;
    width = nextWidth;
    height = nextHeight;
    density = nextDensity;
    // Changing width/height clears a canvas. Allocate only on a real resize,
    // never on a React render or an animation tick, and repaint synchronously.
    canvas.width = buffer.width = Math.round(width * density);
    canvas.height = buffer.height = Math.round(height * density);
    draw();
  }

  function onContextLost(event: Event) {
    event.preventDefault();
    contextLost = true;
    stop();
  }

  function onContextRestored() {
    contextLost = false;
    resize();
    resume();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", resume);
  reducedMotion.addEventListener("change", resume);
  canvas.addEventListener("contextlost", onContextLost);
  canvas.addEventListener("contextrestored", onContextRestored);
  resize();
  resume();

  return () => {
    disposed = true;
    stop();
    observer.disconnect();
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", resume);
    reducedMotion.removeEventListener("change", resume);
    canvas.removeEventListener("contextlost", onContextLost);
    canvas.removeEventListener("contextrestored", onContextRestored);
  };
}
