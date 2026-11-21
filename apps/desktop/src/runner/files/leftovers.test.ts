import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { makeTree, snapshotFor, type Tree } from "./files.fixture.ts";
import { cleanLeftovers, LEFTOVER_AGE_MS } from "./leftovers.ts";

let tree: Tree;
beforeEach(() => {
  tree = makeTree();
});
afterEach(() => tree.cleanup());

const NOW = Date.parse("2026-11-21T10:00:00Z");

function aged(path: string, ms: number): string {
  const at = (NOW - ms) / 1000;
  utimesSync(path, at, at);
  return path;
}

function old(path: string): string {
  return aged(path, LEFTOVER_AGE_MS + 60_000);
}

describe("leftover cleanup on runner start", () => {
  test("removes only the runner's own old temp and backup names in write folders", async () => {
    const stale = old(tree.file(join(tree.docs, "sub", ".subkit-abc-1.tmp"), "partial"));
    const fresh = aged(tree.file(join(tree.docs, ".subkit-abc-2.tmp"), "in use"), 60_000);
    const kept = tree.file(join(tree.docs, "keep.txt"), "x");
    linkSync(kept, join(tree.docs, ".subkit-abc-3.bak"));
    old(join(tree.docs, ".subkit-abc-3.bak"));
    const lonely = old(tree.file(join(tree.docs, ".subkit-abc-4.bak"), "only copy"));
    const lookalike = old(tree.file(join(tree.docs, ".subkit-abc.tmp.txt"), "not ours"));
    const hidden = old(tree.file(join(tree.docs, ".git", ".subkit-abc-5.tmp"), "hidden"));
    const readOnly = old(tree.file(join(tree.reports, ".subkit-abc-6.tmp"), "read folder"));
    const outside = old(tree.file(join(tree.out, ".subkit-abc-7.tmp"), "outside"));
    symlinkSync(tree.out, join(tree.docs, "escape"));
    const trashed: string[] = [];
    const report = await cleanLeftovers(
      snapshotFor(tree, [
        tree.folder("docs", tree.docs, "write"),
        tree.folder("reports", tree.reports, "read"),
      ]),
      {
        now: () => NOW,
        trash: async (path) => {
          trashed.push(path);
          return true;
        },
      },
    );
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(tree.docs, ".subkit-abc-3.bak"))).toBe(false);
    expect(existsSync(kept)).toBe(true);
    expect(trashed).toEqual([lonely]);
    for (const path of [fresh, lookalike, hidden, readOnly, outside])
      expect(existsSync(path)).toBe(true);
    expect(report).toEqual({ removed: 2, trashed: 1, kept: 1 });
  });
});
