import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { directMimeType } from "../src/server/audio.js";
import { sendFileRange, sendTranscodedStream, type SpawnTranscoder } from "../src/server/media.js";

const apps: FastifyInstance[] = [];
const directories: string[] = [];
const children: ReturnType<SpawnTranscoder>[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "music-media-test-"));
  directories.push(directory);
  return directory;
}

async function listen(app: FastifyInstance): Promise<string> {
  apps.push(app);
  return app.listen({ host: "127.0.0.1", port: 0 });
}

function nodeTranscoder(script: string): SpawnTranscoder {
  return () => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    return child;
  };
}

async function transcoderServer(spawnProcess: SpawnTranscoder): Promise<{ app: FastifyInstance; url: string }> {
  const app = Fastify({ forceCloseConnections: true });
  app.get("/audio", async (request, reply) => sendTranscodedStream(request, reply, "/unused/input.m4a", 0, spawnProcess));
  return { app, url: `${await listen(app)}/audio` };
}

describe("real HTTP direct audio responses", () => {
  it("returns all MP3 and AAC M4A bytes from async route handlers", async () => {
    const directory = await temporaryDirectory();
    const content = Buffer.from([0x49, 0x44, 0x33, 0x00, 0xff, 0x11, 0x80]);
    const app = Fastify({ forceCloseConnections: true });
    for (const [name, codec, mime] of [["audio.mp3", "MPEG 1 Layer 3", "audio/mpeg"], ["audio.m4a", "AAC", "audio/mp4"]]) {
      const filePath = path.join(directory, name);
      await fs.writeFile(filePath, content);
      const mimeType = directMimeType({ path: filePath, codec, container: null, formatGroup: "" });
      expect(mimeType).toBe(mime);
      app.get(`/${name}`, async (_request, reply) => sendFileRange(undefined, reply, filePath, mimeType!));
    }
    const url = await listen(app);
    for (const name of ["audio.mp3", "audio.m4a"]) {
      const response = await fetch(`${url}/${name}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(content.length));
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
    }
  });

  it("implements closed, open, suffix, and clipped single ranges with exact bytes", async () => {
    const filePath = path.join(await temporaryDirectory(), "audio.mp3");
    await fs.writeFile(filePath, "0123456789");
    const app = Fastify({ forceCloseConnections: true });
    app.get("/audio", async (request, reply) => sendFileRange(request.headers.range, reply, filePath, "audio/mpeg"));
    const url = `${await listen(app)}/audio`;
    for (const [range, expected, contentRange] of [
      ["bytes=2-5", "2345", "bytes 2-5/10"],
      ["bytes=6-", "6789", "bytes 6-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=-30", "0123456789", "bytes 0-9/10"],
      ["bytes=7-30", "789", "bytes 7-9/10"],
      ["bytes=0-0", "0", "bytes 0-0/10"]
    ]) {
      const response = await fetch(url, { headers: { Range: range } });
      expect(response.status, range).toBe(206);
      expect(response.headers.get("content-range"), range).toBe(contentRange);
      expect(response.headers.get("content-length"), range).toBe(String(expected.length));
      expect(await response.text(), range).toBe(expected);
    }
  });

  it("rejects unsatisfiable or malformed ranges with the complete file size", async () => {
    const filePath = path.join(await temporaryDirectory(), "audio.mp3");
    await fs.writeFile(filePath, "0123456789");
    const app = Fastify({ forceCloseConnections: true });
    app.get("/audio", async (request, reply) => sendFileRange(request.headers.range, reply, filePath, "audio/mpeg"));
    const url = `${await listen(app)}/audio`;
    for (const range of ["bytes=10-", "bytes=6-2", "bytes=-0", "bytes=-", "bytes=0-1,4-5", "items=0-1", "prefixbytes=0-1", "bytes=1-2junk", "bytes=9007199254740992-"]) {
      const response = await fetch(url, { headers: { Range: range } });
      expect(response.status, range).toBe(416);
      expect(response.headers.get("content-range"), range).toBe("bytes */10");
      expect(await response.text()).toBe("");
    }
  });

  it("handles empty files without constructing a negative stream range", async () => {
    const filePath = path.join(await temporaryDirectory(), "empty.mp3");
    await fs.writeFile(filePath, "");
    const app = Fastify({ forceCloseConnections: true });
    app.get("/audio", async (request, reply) => sendFileRange(request.headers.range, reply, filePath, "audio/mpeg"));
    const url = `${await listen(app)}/audio`;
    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("");
    const ranged = await fetch(url, { headers: { Range: "bytes=0-" } });
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get("content-range")).toBe("bytes */0");
    await ranged.arrayBuffer();
  });
});

describe("transcoder response and process lifecycle", () => {
  it("does not kill playback when the incoming GET request closes normally", async () => {
    const { url } = await transcoderServer(nodeTranscoder("setTimeout(() => process.stdout.write('MP3 payload'), 30)"));
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(await response.text()).toBe("MP3 payload");
    expect(children[0].killed).toBe(false);
    expect(children[0].exitCode).toBe(0);
  });

  it("responds with 503 when FFmpeg cannot be started", async () => {
    const { url } = await transcoderServer(() => {
      const child = spawn("/nonexistent-music-test/ffmpeg", [], { stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      return child;
    });
    const response = await fetch(url);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("FFmpeg");
  });

  it("drains stderr, bounds the logged diagnostic, and returns 502 on failure before audio", async () => {
    const { app, url } = await transcoderServer(nodeTranscoder("process.stderr.write('x'.repeat(200000), () => process.exit(2))"));
    const log = vi.spyOn(app.log, "error");
    const response = await fetch(url);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("转码失败");
    const diagnostic = log.mock.calls[0][0] as { stderr: string };
    expect(diagnostic.stderr.length).toBe(8192);
  });

  it("rejects an empty successful process result", async () => {
    const { url } = await transcoderServer(nodeTranscoder("process.exit(0)"));
    const response = await fetch(url);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("未产生可播放内容");
  });

  it("terminates the HTTP body instead of completing successfully after a partial transcode failure", async () => {
    const { url } = await transcoderServer(nodeTranscoder("process.stdout.write('partial'); setTimeout(() => process.exit(2), 100)"));
    const response = await fetch(url);
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(children[0].exitCode).toBe(2);
  });

  it("kills FFmpeg when a client disconnects during streaming", async () => {
    const { url } = await transcoderServer(nodeTranscoder("setInterval(() => process.stdout.write('audio'), 20)"));
    await new Promise<void>((resolve, reject) => {
      const request = http.get(url, (response) => {
        response.once("data", () => {
          const child = children[0];
          const closed = once(child, "close");
          response.destroy();
          void closed.then(() => {
            expect(child.signalCode).toBe("SIGKILL");
            resolve();
          }, reject);
        });
        response.on("error", () => {});
      });
      request.on("error", reject);
    });
  });

  it("kills FFmpeg when a client disconnects before output starts", async () => {
    let notifyStarted: (child: ReturnType<SpawnTranscoder>) => void = () => {};
    const started = new Promise<ReturnType<SpawnTranscoder>>((resolve) => { notifyStarted = resolve; });
    const startProcess = nodeTranscoder("setInterval(() => {}, 1000)");
    const { url } = await transcoderServer((args) => {
      const child = startProcess(args);
      notifyStarted(child);
      return child;
    });
    const request = http.get(url);
    request.on("error", () => {});
    const child = await started;
    const closed = once(child, "close");
    request.destroy();
    await closed;
    expect(child.signalCode).toBe("SIGKILL");
  });
});

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!ffmpegAvailable)("real FFmpeg integration", () => {
  it("converts a temporary ALAC M4A into a nonempty MP3 HTTP response", async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, "generated.m4a");
    const generated = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3",
      "-codec:a", "alac", filePath
    ]);
    expect(generated.status, generated.stderr?.toString()).toBe(0);
    const app = Fastify({ forceCloseConnections: true });
    app.get("/audio", async (request, reply) => sendTranscodedStream(request, reply, filePath));
    const response = await fetch(`${await listen(app)}/audio`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    const output = Buffer.from(await response.arrayBuffer());
    expect(output.length).toBeGreaterThan(1000);
    expect(output.subarray(0, 3).toString()).toBe("ID3");
  });
});
