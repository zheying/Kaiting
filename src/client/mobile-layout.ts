import { useSyncExternalStore } from "react";

const DESKTOP_VIEWPORT_QUERY = "(min-width: 480px)";

interface DeviceEnvironment {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}

export interface MobileLayoutEnvironment extends DeviceEnvironment {
  viewportWidth: number;
}

function prefersMobileLayout(device: DeviceEnvironment, narrowViewport: boolean): boolean {
  const isIPad = /iPad/i.test(device.userAgent) || (device.platform === "MacIntel" && (device.maxTouchPoints ?? 0) > 0);
  if (isIPad) return false;
  if (/iPhone|iPod|Android.+Mobile|Windows Phone|Mobi/i.test(device.userAgent)) return true;
  return narrowViewport;
}

export function shouldUseMobileLayout({ viewportWidth, ...device }: MobileLayoutEnvironment): boolean {
  return prefersMobileLayout(device, Number.isFinite(viewportWidth) && viewportWidth >= 0 && viewportWidth < 480);
}

function clientSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  const { userAgent, platform, maxTouchPoints } = window.navigator;
  const narrowViewport = typeof window.matchMedia === "function"
    ? !window.matchMedia(DESKTOP_VIEWPORT_QUERY).matches
    : Number.isFinite(window.innerWidth) && window.innerWidth >= 0 && window.innerWidth < 480;
  return prefersMobileLayout({ userAgent, platform, maxTouchPoints }, narrowViewport);
}

function subscribeToViewport(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  if (typeof window.matchMedia === "function") {
    const media = window.matchMedia(DESKTOP_VIEWPORT_QUERY);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }
    // Older Safari exposes the same change subscription through addListener.
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

export function useMobileLayout(): boolean {
  return useSyncExternalStore(subscribeToViewport, clientSnapshot, () => false);
}
