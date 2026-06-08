import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertInsideRoot, safeRealPath } from "../src/server/pathSafety.js";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "music-root-"));
  fs.writeFileSync(path.join(root, "song.mp3"), "");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("path safety", () => {
  it("allows paths inside the configured root", () => {
    expect(assertInsideRoot(root, path.join(root, "song.mp3"))).toBe(path.join(root, "song.mp3"));
    expect(safeRealPath(root, path.join(root, "song.mp3"))).toBe(fs.realpathSync.native(path.join(root, "song.mp3")));
  });

  it("rejects traversal outside the configured root", () => {
    expect(() => assertInsideRoot(root, path.join(root, "..", "outside.mp3"))).toThrow(/escapes/);
  });
});
