import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSlashHistory,
  clearSlashHistory,
  loadSlashHistory,
  loadSlashRing,
} from "../repl/history-store.ts";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sk-slash-history-"));
  path = join(dir, "slash-history.jsonl");
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("slash history ring", () => {
  test("appends only entries that start with `/`", () => {
    appendSlashHistory("/help", { path });
    appendSlashHistory("not-a-slash", { path });
    appendSlashHistory("", { path });
    expect(loadSlashHistory(path).map((e) => e.s)).toEqual(["/help"]);
  });

  test("dedupes against the most recent entry", () => {
    appendSlashHistory("/help", { path });
    appendSlashHistory("/help", { path });
    appendSlashHistory("/clear", { path });
    appendSlashHistory("/clear", { path });
    expect(loadSlashHistory(path).map((e) => e.s)).toEqual(["/help", "/clear"]);
  });

  test("loadSlashRing returns oldest-first invocation strings", () => {
    appendSlashHistory("/audit", { path });
    appendSlashHistory("/connector", { path });
    appendSlashHistory("/workflow", { path });
    expect(loadSlashRing(path)).toEqual(["/audit", "/connector", "/workflow"]);
  });

  test("clearSlashHistory empties the file", () => {
    appendSlashHistory("/a", { path });
    appendSlashHistory("/b", { path });
    clearSlashHistory(path);
    expect(loadSlashHistory(path)).toEqual([]);
  });

  test("tenant-filtered read drops untagged rows", () => {
    appendSlashHistory("/x", { path, tenant: "t1" });
    appendSlashHistory("/y", { path, tenant: "t2" });
    appendSlashHistory("/z", { path, tenant: null });
    const ring = loadSlashRing(path, { tenant: "t1" });
    expect(ring).toEqual(["/x"]);
    expect(loadSlashRing(path)).toEqual(["/x", "/y", "/z"]);
  });
});
