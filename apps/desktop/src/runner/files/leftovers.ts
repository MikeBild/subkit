import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { classifyRelativePath } from "@shared/local-policy/paths.ts";
import { type FilesSnapshot, OWN_TEMP_NAME } from "../../shared/local/files-allowances.ts";

export const LEFTOVER_AGE_MS = 60 * 60 * 1000;
export const LEFTOVER_SCAN = Object.freeze({ depth: 12, entries: 50_000 });

export interface LeftoverDeps {
  readonly now: () => number;
  readonly trash: (path: string) => Promise<boolean>;
}

export interface LeftoverReport {
  removed: number;
  trashed: number;
  kept: number;
}

async function settle(path: string, deps: LeftoverDeps, report: LeftoverReport): Promise<void> {
  const stats = await lstat(path).catch(() => null);
  if (!stats?.isFile() || deps.now() - stats.mtimeMs < LEFTOVER_AGE_MS) {
    report.kept += 1;
    return;
  }
  if (path.endsWith(".tmp") || stats.nlink >= 2) {
    await unlink(path).then(
      () => {
        report.removed += 1;
      },
      () => {
        report.kept += 1;
      },
    );
    return;
  }
  if (await deps.trash(path).catch(() => false)) report.trashed += 1;
  else report.kept += 1;
}

async function scanRoot(root: string, deps: LeftoverDeps, report: LeftoverReport): Promise<void> {
  const real = await realpath(root).catch(() => null);
  if (real !== root) return;
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  let seen = 0;
  while (queue.length > 0 && seen < LEFTOVER_SCAN.entries) {
    const { path, depth } = queue.shift() as { path: string; depth: number };
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      seen += 1;
      if (seen > LEFTOVER_SCAN.entries) return;
      const child = `${path}/${entry.name}`;
      if (entry.isFile() && OWN_TEMP_NAME.test(entry.name)) await settle(child, deps, report);
      else if (
        entry.isDirectory() &&
        depth < LEFTOVER_SCAN.depth &&
        classifyRelativePath(entry.name, "darwin").ok
      )
        queue.push({ path: child, depth: depth + 1 });
    }
  }
}

export async function cleanLeftovers(
  snapshot: FilesSnapshot,
  deps: LeftoverDeps,
): Promise<LeftoverReport> {
  const report: LeftoverReport = { removed: 0, trashed: 0, kept: 0 };
  for (const folder of snapshot.folders) {
    if (folder.access === "write") await scanRoot(folder.path, deps, report);
  }
  return report;
}
