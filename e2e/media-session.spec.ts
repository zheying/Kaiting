import type { Page } from "@playwright/test";
import { test, expect, titles } from "./helpers/room.js";

type SessionProbe = {
  actions: Record<string, MediaSessionActionHandler | null>;
  position: MediaPositionState | null;
  audio: HTMLAudioElement[];
  activity: { event: string; src: string | null; playing: string[] }[];
};
type ProbeWindow = typeof window & { sessionProbe: SessionProbe };

test.beforeEach(async ({ page }) => {
  // 只在系统 API 边界记录注册的回调；音频、播放器状态和媒体事件均保持真实。
  await page.addInitScript(() => {
    const probe: SessionProbe = { actions: {}, position: null, audio: [], activity: [] };
    (window as ProbeWindow).sessionProbe = probe;
    // 保留原生元素的只读观察引用，不替换媒体实现或操纵事件。
    window.Audio = new Proxy(window.Audio, { construct(target, args) {
      const audio = Reflect.construct(target, args) as HTMLAudioElement;
      probe.audio.push(audio);
      for (const event of ["playing", "pause", "emptied", "error"]) audio.addEventListener(event, () => {
        probe.activity.push({ event, src: audio.getAttribute("src"), playing: probe.audio.filter((item) => !item.paused && !item.ended && item.readyState >= 3).map((item) => item.currentSrc) });
      });
      return audio;
    } });
    const session = navigator.mediaSession;
    const register = session.setActionHandler.bind(session);
    session.setActionHandler = (action, handler) => { probe.actions[action] = handler; register(action, handler); };
    const position = session.setPositionState.bind(session);
    session.setPositionState = (value) => { position(value); probe.position = value?.duration === undefined ? null : { ...value }; };
  });
});

const sessionState = (page: Page) => page.evaluate(() => ({
  playback: navigator.mediaSession.playbackState,
  title: navigator.mediaSession.metadata?.title,
  position: (window as ProbeWindow).sessionProbe.position,
  actions: Object.entries((window as ProbeWindow).sessionProbe.actions).filter(([, handler]) => handler).map(([action]) => action)
}));
const action = (page: Page, value: MediaSessionActionDetails) => page.evaluate((details) => {
  const handler = (window as ProbeWindow).sessionProbe.actions[details.action];
  if (!handler) throw new Error(`没有注册媒体操作：${details.action}`);
  handler(details);
}, value);
const audioState = (page: Page) => page.evaluate(() => (window as ProbeWindow).sessionProbe.audio.map((audio) => ({
  src: audio.getAttribute("src"), paused: audio.paused, ended: audio.ended, readyState: audio.readyState, time: audio.currentTime
})));
const audioActivity = (page: Page) => page.evaluate(() => (window as ProbeWindow).sessionProbe.activity);

for (const format of ["aac", "alac"] as const) test(`Media Session ${format.toUpperCase()} 播放进度、明确的播放暂停、转码 seek 与切歌同步`, async ({ page, room }, info) => {
  await room.ready(page);
  const song = await room.track(page.request, titles[format]);
  const streamRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes(`/api/tracks/${song.id}/stream`)) streamRequests.push(request.url()); });
  await page.getByRole("button", { name: `播放 ${titles[format]}`, exact: true }).click();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  const progress = player.getByRole("slider", { name: "播放进度", exact: true });
  await expect.poll(async () => (await sessionState(page)).playback).toBe("playing");
  await expect.poll(async () => (await sessionState(page)).position?.position ?? 0).toBeGreaterThan(0.1);
  await action(page, { action: "pause" });
  await action(page, { action: "pause" });
  await expect(player.getByRole("button", { name: "播放", exact: true })).toBeVisible();
  expect((await sessionState(page)).playback).toBe("paused");
  expect((await sessionState(page)).position?.duration).toBeCloseTo(song.duration, 1);
  await action(page, { action: "seekto", seekTime: 2 });
  await expect(progress).toHaveValue("2");
  await expect.poll(async () => (await sessionState(page)).position?.position).toBe(2);
  const pausedPosition = Number(await progress.inputValue());
  await page.waitForTimeout(250);
  expect(Number(await progress.inputValue())).toBe(pausedPosition);
  await action(page, { action: "play" });
  await action(page, { action: "play" });
  await expect(player.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
  await expect.poll(async () => (await sessionState(page)).position?.position ?? 0).toBeGreaterThan(2.15);
  await action(page, { action: "pause" });
  expect((await sessionState(page)).playback).toBe("paused");
  if (format === "alac") expect(streamRequests.some((url) => new URL(url).searchParams.get("start") === "2")).toBe(true);
  else expect(streamRequests.every((url) => !new URL(url).searchParams.has("start"))).toBe(true);
  await action(page, { action: "seekbackward", seekOffset: 1 });
  expect((await sessionState(page)).position!.position!).toBeLessThan(2);
  const beforeInvalid = (await sessionState(page)).position!.position;
  await action(page, { action: "seekto", seekTime: Number.NaN });
  expect((await sessionState(page)).position?.position).toBe(beforeInvalid);
  await action(page, { action: "nexttrack" });
  await expect.poll(async () => (await sessionState(page)).title).toBe(format === "aac" ? titles.alac : titles.flac);
  await expect(player.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
  await action(page, { action: "pause" });
  await action(page, { action: "previoustrack" });
  await expect.poll(async () => (await sessionState(page)).title).toBe(titles[format]);
  await expect(player.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
  await action(page, { action: "pause" });
  await info.attach("media-session.json", { body: JSON.stringify(await sessionState(page), null, 2), contentType: "application/json" });
  await info.attach("player.png", { body: await player.screenshot(), contentType: "image/png" });
});

test("Media Session 缓冲中暂停取消播放，结束后可从零重播", async ({ page, room }, info) => {
  await room.ready(page);
  const song = await room.track(page.request, titles.alac);
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  await expect.poll(async () => (await sessionState(page)).position?.position ?? 0).toBeGreaterThan(0.1);
  await page.getByRole("button", { name: "ALAC", exact: true }).click();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/tracks/${song.id}/stream*`, async (route) => { await held; await route.continue().catch(() => undefined); });
  await page.getByRole("button", { name: `播放 ${titles.alac}`, exact: true }).click();
  await expect.poll(async () => (await sessionState(page)).playback).toBe("playing");
  await action(page, { action: "pause" });
  release();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  await expect(player.getByRole("button", { name: "播放", exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  expect((await sessionState(page)).playback).toBe("paused");
  expect((await audioState(page)).every((audio) => audio.paused)).toBe(true);
  await action(page, { action: "seekto", seekTime: song.duration - 0.6 });
  await action(page, { action: "play" });
  await expect.poll(async () => (await sessionState(page)).playback).toBe("playing");
  await expect.poll(async () => (await sessionState(page)).playback).toBe("paused");
  expect((await sessionState(page)).position?.position).toBeCloseTo(song.duration, 1);
  await action(page, { action: "play" });
  await action(page, { action: "play" });
  await expect(player.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
  await expect.poll(async () => (await sessionState(page)).position?.position ?? 0).toBeGreaterThan(0.1);
  expect((await sessionState(page)).position!.position!).toBeLessThan(2);
  await action(page, { action: "pause" });
  await info.attach("completed-replay.json", { body: JSON.stringify(await sessionState(page), null, 2), contentType: "application/json" });
});

test("Media Session 可选系统接口失败仍能播放、暂停和切歌", async ({ page, room }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const unsupported = () => { throw new DOMException("平台不支持此操作", "NotSupportedError"); };
    Object.defineProperty(window, "MediaMetadata", { value: class { constructor() { unsupported(); } } });
    const session = navigator.mediaSession;
    session.setPositionState = unsupported;
    const register = session.setActionHandler.bind(session);
    session.setActionHandler = (name, handler) => {
      if (name === "seekforward" || name === "seekbackward") unsupported();
      register(name, handler);
    };
  });
  await room.ready(page);
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  const progress = player.getByRole("slider", { name: "播放进度", exact: true });
  await expect.poll(async () => Number(await progress.inputValue())).toBeGreaterThan(0.1);
  await action(page, { action: "pause" });
  await expect(player.getByRole("button", { name: "播放", exact: true })).toBeVisible();
  expect((await sessionState(page)).playback).toBe("paused");
  await action(page, { action: "play" });
  await expect(player.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
  expect((await sessionState(page)).playback).toBe("playing");
  await action(page, { action: "nexttrack" });
  await expect(player).toContainText(titles.alac);
  await expect(player.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
  await action(page, { action: "pause" });
  expect(errors).toEqual([]);
  await info.attach("optional-interface-failures.json", { body: JSON.stringify({ session: await sessionState(page), errors }, null, 2), contentType: "application/json" });
});

test("Media Session 切歌交接保留旧播放器直到新曲实际播放", async ({ page, room }, info) => {
  // 观察真实浏览器的媒体调试事件，不替换 audio 或伪造媒体状态。
  const debug = await page.context().newCDPSession(page);
  const events: { at: number; event: string; data: unknown }[] = [];
  const lifecycle: { playerId: string; timestamp: number; value: { event?: string; url?: string; pipeline_state?: string } }[] = [];
  const started = Date.now();
  for (const name of ["Media.playerEventsAdded", "Media.playerPropertiesChanged", "Media.playerErrorsRaised"] as const) {
    debug.on(name, (data) => events.push({ at: Date.now() - started, event: name, data }));
  }
  debug.on("Media.playerEventsAdded", ({ playerId, events }) => {
    lifecycle.push(...events.map(({ timestamp, value }) => ({ playerId, timestamp, value: JSON.parse(value) })));
  });
  await debug.send("Media.enable");
  await room.ready(page);
  const first = await room.track(page.request, titles.aac);
  const next = await room.track(page.request, titles.alac);
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  const player = page.getByRole("contentinfo", { name: "底部播放器" });
  await expect(player.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
  await expect.poll(() => lifecycle.some((event) => event.value.url?.includes(first.id))).toBe(true);
  const oldPlayer = lifecycle.find((event) => event.value.url?.includes(first.id))!.playerId;
  const before = await sessionState(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/tracks/${next.id}/stream*`, async (route) => { await held; await route.continue().catch(() => undefined); });
  const switchingAt = Date.now() - started;
  const request = page.waitForRequest((entry) => entry.url().includes(`/api/tracks/${next.id}/stream`));
  await action(page, { action: "nexttrack" });
  await request;
  let loading: Awaited<ReturnType<typeof sessionState>> | undefined;
  try {
    // 故意延迟首包，区分网页仍维持的 Media Session 和底层播放器空档。
    await page.waitForTimeout(1500);
    loading = await sessionState(page);
    expect(loading.title).toBe(titles.alac);
    expect(loading.playback).toBe("playing");
    expect(loading.actions).toContain("nexttrack");
    expect(loading.actions).toContain("pause");
    expect(lifecycle.filter((event) => event.playerId === oldPlayer && event.value.event === "kWebMediaPlayerDestroyed")).toEqual([]);
    expect((await audioState(page)).find((audio) => audio.src?.includes(first.id))?.paused).toBe(true);
    release();
    await expect(player.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
    await expect.poll(async () => (await sessionState(page)).position?.position ?? 0).toBeGreaterThan(0.1);
    await action(page, { action: "pause" });
    await expect.poll(() => lifecycle.some((event) => event.playerId === oldPlayer && event.value.event === "kWebMediaPlayerDestroyed")).toBe(true);
    const newPlayer = lifecycle.find((event) => event.value.url?.includes(next.id))!.playerId;
    // CDP 分播放器批量投递，销毁事件可能先于新曲的历史事件到达。
    await expect.poll(() => lifecycle.some((event) => event.playerId === newPlayer && event.value.pipeline_state === "kPlaying")).toBe(true);
    const started = lifecycle.find((event) => event.playerId === newPlayer && event.value.pipeline_state === "kPlaying")!;
    const destroyed = lifecycle.find((event) => event.playerId === oldPlayer && event.value.event === "kWebMediaPlayerDestroyed")!;
    expect(destroyed.timestamp).toBeGreaterThanOrEqual(started.timestamp);
    expect((await audioState(page)).filter((audio) => audio.src)).toHaveLength(1);
    expect((await audioActivity(page)).every((event) => event.playing.length <= 1)).toBe(true);
  } finally {
    release();
    await info.attach("transition-lifecycle.json", { body: JSON.stringify({ switchingAt, before, loading, after: await sessionState(page), events, audio: await audioState(page), activity: await audioActivity(page) }, null, 2), contentType: "application/json" });
    await debug.detach();
  }
});

test("Media Session 连续切歌丢弃迟到请求，退出释放全部音频", async ({ page, room }, info) => {
  await room.ready(page);
  const second = await room.track(page.request, titles.alac);
  const third = await room.track(page.request, titles.flac);
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  await expect.poll(async () => (await sessionState(page)).position?.position ?? 0).toBeGreaterThan(0.1);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/tracks/${second.id}/stream*`, async (route) => { await held; await route.continue().catch(() => undefined); });
  const pending = page.waitForRequest((request) => request.url().includes(`/api/tracks/${second.id}/stream`));
  await action(page, { action: "nexttrack" });
  await pending;
  try {
    await action(page, { action: "nexttrack" });
    await expect.poll(async () => (await sessionState(page)).title).toBe(titles.flac);
    await expect.poll(async () => (await sessionState(page)).position?.position ?? 0).toBeGreaterThan(0.1);
    release();
    await page.waitForTimeout(500);
    expect((await sessionState(page)).title).toBe(titles.flac);
    expect((await sessionState(page)).playback).toBe("playing");
    const active = (await audioState(page)).filter((audio) => !audio.paused);
    expect(active).toHaveLength(1);
    expect(active[0].src).toContain(third.id);
    expect((await audioState(page)).filter((audio) => audio.src)).toHaveLength(1);
    expect((await audioActivity(page)).every((event) => event.playing.length <= 1)).toBe(true);
    await page.goto(`${room.url}/#/account`);
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByRole("button", { name: "确认退出", exact: true }).click();
    await expect.poll(async () => (await sessionState(page)).playback).toBe("none");
    expect((await audioState(page)).every((audio) => audio.paused && audio.src === null)).toBe(true);
    expect((await sessionState(page)).actions).toEqual([]);
  } finally {
    release();
    await info.attach("rapid-switch-and-logout.json", { body: JSON.stringify({ session: await sessionState(page), audio: await audioState(page), activity: await audioActivity(page) }, null, 2), contentType: "application/json" });
  }
});

test("Media Session 切歌失败不恢复旧曲，重试后完成交接", async ({ page, room }, info) => {
  await room.ready(page);
  const next = await room.track(page.request, titles.alac);
  await page.getByRole("button", { name: `播放 ${titles.aac}`, exact: true }).click();
  await expect.poll(async () => (await sessionState(page)).position?.position ?? 0).toBeGreaterThan(0.1);
  await page.route(`**/api/tracks/${next.id}/stream*`, (route) => route.abort("failed"));
  await action(page, { action: "nexttrack" });
  await expect.poll(async () => (await sessionState(page)).playback).toBe("paused");
  expect((await sessionState(page)).title).toBe(titles.alac);
  expect((await audioState(page)).every((audio) => audio.paused)).toBe(true);
  await page.unroute(`**/api/tracks/${next.id}/stream*`);
  await action(page, { action: "play" });
  await expect.poll(async () => (await sessionState(page)).position?.position ?? 0).toBeGreaterThan(0.1);
  expect((await sessionState(page)).playback).toBe("playing");
  const resources = (await audioState(page)).filter((audio) => audio.src);
  expect(resources).toHaveLength(1);
  expect(resources[0].src).toContain(next.id);
  expect((await audioActivity(page)).every((event) => event.playing.length <= 1)).toBe(true);
  await action(page, { action: "pause" });
  await info.attach("failed-switch-retry.json", { body: JSON.stringify({ session: await sessionState(page), audio: await audioState(page), activity: await audioActivity(page) }, null, 2), contentType: "application/json" });
});
