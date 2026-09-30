import { afterEach, describe, expect, it, vi } from "vitest";
export function loginSceneContract(startLoginScene: (canvas: HTMLCanvasElement) => (() => void) | undefined) {

function sceneHarness(reduceMotion = false) {
  const createContext = () => ({
    fillRect: vi.fn(), stroke: vi.fn(), setTransform: vi.fn(), drawImage: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} })
  });
  class Canvas extends EventTarget {
    context = createContext();
    allocations = 0;
    pixelWidth = 0;
    pixelHeight = 0;
    bounds = { width: 1024, height: 768 };
    get width() { return this.pixelWidth; }
    set width(value: number) { this.allocations++; this.pixelWidth = value; }
    get height() { return this.pixelHeight; }
    set height(value: number) { this.allocations++; this.pixelHeight = value; }
    getContext() { return this.context; }
    getBoundingClientRect() { return this.bounds; }
  }
  const canvas = new Canvas();
  const buffer = new Canvas();
  const motion = Object.assign(new EventTarget(), { matches: reduceMotion });
  const doc = Object.assign(new EventTarget(), { hidden: false, createElement: () => buffer });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const win = Object.assign(new EventTarget(), {
    devicePixelRatio: 2,
    matchMedia: () => motion,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); }
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const start = () => startLoginScene(canvas as unknown as HTMLCanvasElement);
  const tick = (timestamp: number) => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(timestamp);
  };
  return { canvas, buffer, motion, doc, win, frames, start, tick };
}

afterEach(() => vi.unstubAllGlobals());

describe("登录背景动画的帧与生命周期", () => {
  it("稳定尺寸下不重建画布，每次只发布完整帧；重复尺寸通知不会清空画面", () => {
    const { canvas, buffer, win, start, tick } = sceneHarness();
    const stop = start();
    const allocations = canvas.allocations;
    const presented = canvas.context.drawImage.mock.calls.length;
    tick(0); tick(16); tick(32);
    win.dispatchEvent(new Event("resize"));
    expect(canvas.allocations).toBe(allocations);
    expect(canvas.context.fillRect).not.toHaveBeenCalled();
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(presented + 3);
    canvas.bounds = { width: 393, height: 852 };
    win.dispatchEvent(new Event("resize"));
    expect([canvas.width, canvas.height]).toEqual([786, 1704]);
    const points = buffer.context.lineTo.mock.calls.flat();
    expect(points.every(Number.isFinite)).toBe(true);
    stop?.();
  });

  it("隐藏标签页会暂停，返回后相位接续，不补算后台停留时间", () => {
    const { canvas, buffer, doc, frames, start, tick } = sceneHarness();
    const stop = start();
    tick(0); tick(16);
    const before = buffer.context.lineTo.mock.lastCall;
    doc.hidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    const presented = canvas.context.drawImage.mock.calls.length;
    tick(30000);
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(presented);
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    tick(40000);
    expect(buffer.context.lineTo.mock.lastCall).toEqual(before);
    expect(frames.size).toBe(1);
    stop?.();
  });

  it("减少动态效果时只绘制静帧，偏好切换不会创建重复动画循环", () => {
    const { canvas, motion, frames, start } = sceneHarness(true);
    const stop = start();
    expect(canvas.context.drawImage).toHaveBeenCalled();
    expect(frames.size).toBe(0);
    motion.matches = false;
    motion.dispatchEvent(new Event("change"));
    motion.dispatchEvent(new Event("change"));
    expect(frames.size).toBe(1);
    motion.matches = true;
    motion.dispatchEvent(new Event("change"));
    expect(frames.size).toBe(0);
    stop?.();
  });

  it("卸载后停止绘制，重新挂载仍只有一个循环", () => {
    const { canvas, doc, win, frames, start, tick } = sceneHarness();
    const firstStop = start();
    firstStop?.();
    expect(frames.size).toBe(0);
    const presented = canvas.context.drawImage.mock.calls.length;
    win.dispatchEvent(new Event("resize"));
    doc.dispatchEvent(new Event("visibilitychange"));
    tick(100);
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(presented);
    const secondStop = start();
    expect(frames.size).toBe(1);
    secondStop?.();
    expect(frames.size).toBe(0);
  });
});
}
