import fs from "node:fs";
import path from "node:path";

export function assertInsideRoot(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }

  throw new Error(`Path escapes configured root: ${target}`);
}

export function safeRealPath(root: string, target: string): string {
  const safeTarget = assertInsideRoot(root, target);
  const realRoot = fs.realpathSync.native(root);
  const realTarget = fs.realpathSync.native(safeTarget);
  return assertInsideRoot(realRoot, realTarget);
}
