import fs from "node:fs";
import path from "node:path";

export function assertInsideRoot(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }

  throw new Error(`Path escapes configured root: ${target}`);
}

export function safeRealPath(root: string, target: string): string {
  const realRoot = fs.realpathSync.native(root);
  let safeTarget: string;
  try {
    safeTarget = assertInsideRoot(root, target);
  } catch {
    // Scanned records store canonical paths even when the configured NAS root
    // is a symlink or the operating system exposes it through a path alias.
    safeTarget = assertInsideRoot(realRoot, target);
  }
  const realTarget = fs.realpathSync.native(safeTarget);
  return assertInsideRoot(realRoot, realTarget);
}
