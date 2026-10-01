import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { createMusicLibrary, MusicFailure } from "./music-library.js";

export function musicPlugin(root: string, dataDir: string): Plugin {
  const library = createMusicLibrary(root, dataDir);
  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(body)); };
  async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/__prototype/music/")) { next(); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { json(res, 405, { error: "仅支持只读请求。" }); return; }
    if (req.headers["sec-fetch-site"] === "cross-site" || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) { json(res, 403, { error: "只允许当前原型访问。" }); return; }
    try {
      if (url.pathname === "/__prototype/music/catalog") { json(res, 200, await library.catalog()); return; }
      const match = /^\/__prototype\/music\/(prepare|audio)\/([a-f0-9]{24})$/.exec(url.pathname);
      if (!match) throw new MusicFailure(404, "没有这个音源。");
      if (match[1] === "prepare") { json(res, 200, await library.prepare(match[2])); return; }
      const { file, mime, size } = await library.audio(match[2]);
      let start = 0, end = size - 1, status = 200;
      if (req.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!range || (!range[1] && !range[2])) { res.setHeader("Content-Range", `bytes */${size}`); throw new MusicFailure(416, "无效的音频范围。"); }
        start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || (!range[1] && Number(range[2]) === 0)) { res.setHeader("Content-Range", `bytes */${size}`); throw new MusicFailure(416, "无效的音频范围。"); }
        status = 206;
      }
      res.writeHead(status, { "Content-Type": mime, "Content-Length": end - start + 1, "Accept-Ranges": "bytes", "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff", ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
      if (req.method === "HEAD") { res.end(); return; }
      const stream = fs.createReadStream(file, { start, end });
      res.once("close", () => stream.destroy()); stream.once("error", () => res.destroy()); stream.pipe(res);
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof MusicFailure ? error.status : 503, { error: error instanceof MusicFailure ? error.message : "真实音源暂时不可用，请重试。" });
      else res.destroy();
    }
  }
  return { name: "prototype-read-only-music", configureServer(server) { server.middlewares.use((req, res, next) => { void handle(req, res, next); }); }, configurePreviewServer(server) { server.middlewares.use((req, res, next) => { void handle(req, res, next); }); } };
}
