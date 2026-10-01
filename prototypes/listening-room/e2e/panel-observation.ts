import type { Page } from "@playwright/test";

type Frame = {
  stage: number[]; canvas: number[]; footer: number[]; nav: number[];
  stageOpacity: number; playing: boolean;
  panels: { label: string; opacity: number }[];
};
type ObservedWindow = Window & { panelObservation: { running: boolean; frames: Frame[] } };

export async function observePanels(page: Page) {
  await page.evaluate(() => {
    const observation = { running: true, frames: [] as Frame[] };
    (window as unknown as ObservedWindow).panelObservation = observation;
    const rect = (selector: string) => {
      const value = document.querySelector(selector)!.getBoundingClientRect();
      return [value.x, value.y, value.width, value.height].map((n) => Math.round(n * 100) / 100);
    };
    const sample = () => {
      if (!observation.running) return;
      observation.frames.push({
        stage: rect(".av-visual"), footer: rect(".av-footer"), nav: rect(".av-theme-nav"),
        canvas: Array.from(document.querySelectorAll<HTMLCanvasElement>(".av-visual canvas")).flatMap((node) => [node.width, node.height]),
        stageOpacity: Number(getComputedStyle(document.querySelector(".av-visual")!).opacity),
        playing: !document.querySelector("audio")!.paused,
        panels: Array.from(document.querySelectorAll<HTMLElement>(".av-companion")).map((node) => ({ label: node.getAttribute("aria-label")!, opacity: Number(getComputedStyle(node).opacity) }))
      });
      requestAnimationFrame(sample);
    };
    sample();
  });
}

export const finishPanelObservation = (page: Page) => page.evaluate(() => {
  const observation = (window as unknown as ObservedWindow).panelObservation;
  observation.running = false;
  return observation.frames;
});
