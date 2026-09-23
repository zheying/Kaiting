import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { shouldUseMobileLayout, useMobileLayout } from "../src/client/mobile-layout.js";

const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
const iPhone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const iPad = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const androidPhone = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36";
const androidTablet = "Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";

describe("mobile layout selection", () => {
  it.each([393, 479, 479.5, 479.999])("uses the mobile shell for a desktop UA at %s CSS pixels", (viewportWidth) => {
    expect(shouldUseMobileLayout({ userAgent: desktop, platform: "MacIntel", maxTouchPoints: 0, viewportWidth })).toBe(true);
  });

  it.each([480, 480.01, 852, 1280])("keeps the desktop shell at %s CSS pixels", (viewportWidth) => {
    expect(shouldUseMobileLayout({ userAgent: desktop, platform: "MacIntel", maxTouchPoints: 0, viewportWidth })).toBe(false);
  });

  it.each([iPhone, androidPhone, "Mozilla/5.0 (iPod; CPU iPhone OS 15_0 like Mac OS X)", "Mozilla/5.0 (Windows Phone 10.0)"])("keeps a phone UA in the mobile shell even at a wide viewport", (userAgent) => {
    expect(shouldUseMobileLayout({ userAgent, viewportWidth: 1024 })).toBe(true);
  });

  it.each([393, 480, 1024])("keeps an explicit iPad UA in the tablet shell at width %s", (viewportWidth) => {
    expect(shouldUseMobileLayout({ userAgent: iPad, platform: "iPad", maxTouchPoints: 5, viewportWidth })).toBe(false);
  });

  it.each([1, 5])("recognizes desktop-style iPadOS with MacIntel and %s touch points", (maxTouchPoints) => {
    expect(shouldUseMobileLayout({ userAgent: desktop, platform: "MacIntel", maxTouchPoints, viewportWidth: 393 })).toBe(false);
  });

  it("does not classify a Windows touch laptop as iPadOS", () => {
    expect(shouldUseMobileLayout({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32", maxTouchPoints: 10, viewportWidth: 393 })).toBe(true);
  });

  it("lets non-iPad tablets use the narrow viewport fallback", () => {
    expect(shouldUseMobileLayout({ userAgent: androidTablet, viewportWidth: 393 })).toBe(true);
    expect(shouldUseMobileLayout({ userAgent: androidTablet, viewportWidth: 800 })).toBe(false);
  });

  it("does not activate a viewport fallback for invalid dimensions", () => {
    for (const viewportWidth of [NaN, Infinity, -1]) expect(shouldUseMobileLayout({ userAgent: desktop, viewportWidth })).toBe(false);
  });

  it("renders safely on the server without browser globals", () => {
    function Probe() { return createElement("output", null, useMobileLayout() ? "mobile" : "desktop"); }
    expect(renderToString(createElement(Probe))).toBe("<output>desktop</output>");
  });
});
