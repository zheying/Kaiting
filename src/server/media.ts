import fs from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";

/** filePath must already have been validated with safeRealPath by the caller. */
export function sendFileRange(range: string | undefined, reply: FastifyReply, filePath: string, mimeType: string): FastifyReply {
  const { size } = fs.statSync(filePath);
  reply.header("Accept-Ranges", "bytes").type(mimeType);

  if (!range) {
    reply.header("Content-Length", size);
    return reply.send(fs.createReadStream(filePath));
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  const unsatisfiable = () => reply.code(416).header("Content-Range", `bytes */${size}`).send();
  if (!match || (!match[1] && !match[2]) || size === 0) return unsatisfiable();

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (suffixLength === 0) return unsatisfiable();
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || start >= size || start > end) return unsatisfiable();
  }

  return reply.code(206)
    .header("Content-Length", end - start + 1)
    .header("Content-Range", `bytes ${start}-${end}/${size}`)
    .send(fs.createReadStream(filePath, { start, end }));
}

type Transcoder = ChildProcessByStdio<null, Readable, Readable>;
export type SpawnTranscoder = (args: string[]) => Transcoder;

const spawnTranscoder: SpawnTranscoder = (args) => spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
const MAX_STDERR_BYTES = 8192;

/** filePath must already have been validated with safeRealPath by the caller. */
export async function sendTranscodedStream(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  start = 0,
  spawnProcess: SpawnTranscoder = spawnTranscoder
): Promise<FastifyReply> {
  const seek = Number.isFinite(start) ? Math.max(0, start) : 0;
  let child: Transcoder;
  try {
    child = spawnProcess([
      "-hide_banner", "-loglevel", "error", "-nostdin",
      ...(seek > 0 ? ["-ss", String(seek)] : []),
      "-i", filePath, "-vn", "-map_metadata", "-1",
      "-codec:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "pipe:1"
    ]);
  } catch (error) {
    request.log.error({ err: error }, "无法启动音频转码");
    return reply.code(503).send({ error: "无法启动音频转码，请检查 FFmpeg 是否已安装" });
  }

  // Hold EOF until FFmpeg exits successfully, so truncated output cannot look like
  // a completed audio response. PassThrough also preserves stream backpressure.
  const output = new PassThrough();
  let stderr = Buffer.alloc(0);
  let exited = false;
  let disconnected = false;
  let streaming = false;
  let failure: { status: number; message: string } | undefined;
  let wake: () => void = () => {};
  const ready = new Promise<void>((resolve) => { wake = resolve; });
  const startupTimeout = setTimeout(() => {
    fail(504, "音频转码启动超时，请稍后重试");
  }, 30_000);
  startupTimeout.unref();

  function stopProcess(): void {
    if (!exited && !child.killed) child.kill("SIGKILL");
  }

  function detachResponseListeners(): void {
    reply.raw.off("close", onResponseClose);
    request.raw.off("aborted", onResponseClose);
  }

  function onResponseClose(): void {
    disconnected = true;
    clearTimeout(startupTimeout);
    output.destroy();
    stopProcess();
    detachResponseListeners();
    wake();
  }

  function fail(status: number, message: string, error?: Error): void {
    if (failure || disconnected) return;
    failure = { status, message };
    clearTimeout(startupTimeout);
    request.log.error({ err: error, stderr: stderr.toString("utf8") }, message);
    if (streaming) output.destroy(error ?? new Error(message));
    else output.destroy();
    stopProcess();
    wake();
  }

  // The request's normal "close" fires once its body is read, before playback
  // completes. Only a response close or an aborted request cancels FFmpeg.
  reply.raw.once("close", onResponseClose);
  request.raw.once("aborted", onResponseClose);
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk.subarray(-MAX_STDERR_BYTES)]).subarray(-MAX_STDERR_BYTES);
  });
  child.stderr.on("error", (error: Error) => fail(502, "音频转码失败，请稍后重试", error));
  child.stdout.on("error", (error: Error) => fail(502, "音频转码失败，请稍后重试", error));
  child.once("error", (error: Error) => fail(503, "无法启动音频转码，请检查 FFmpeg 是否已安装", error));
  child.once("close", (code, signal) => {
    exited = true;
    clearTimeout(startupTimeout);
    detachResponseListeners();
    if (disconnected || failure) return;
    if (code !== 0 || signal) {
      fail(502, "音频转码失败，请检查音频文件或服务器日志", new Error(`FFmpeg exited with code ${code}, signal ${signal}`));
    } else if (!streaming && output.readableLength === 0) {
      fail(502, "音频转码未产生可播放内容");
    } else {
      output.end();
      wake();
    }
  });
  output.once("readable", () => {
    if (output.readableLength > 0) {
      clearTimeout(startupTimeout);
      wake();
    }
  });
  child.stdout.pipe(output, { end: false });

  if (request.raw.aborted || reply.raw.destroyed) onResponseClose();
  await ready;
  if (disconnected) return reply;
  if (failure) return reply.code(failure.status).send({ error: failure.message });
  streaming = true;
  return reply.type("audio/mpeg").send(output);
}
