import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const SKIPPED_DIRS = new Set(["node_modules", "dist", ".turbo", ".stryker-tmp"]);

export function listFiles(root: string, predicate: (p: string) => boolean): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (SKIPPED_DIRS.has(name)) continue;
        if (name === "worktrees" && basename(dir) === ".claude") continue;
        stack.push(p);
      } else if (predicate(p)) {
        out.push(p);
      }
    }
  }
  return out;
}
