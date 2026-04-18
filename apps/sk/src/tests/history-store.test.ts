// Unit tests for the persistent REPL history store. Every test uses
// a fresh tmpdir path so runs don't touch the user's real ~/.sk.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHistory,
  clearHistory,
  loadHistory,
  loadPromptRing,
  MAX_HISTORY,
} from "../repl/history-store.ts";

const dirs: string[] = [];
function tmpHistoryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sk-hist-"));
  dirs.push(dir);
  return join(dir, "history.jsonl");
}

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("history-store: load + append", () => {
  test("loadHistory returns [] when the file does not exist", () => {
    expect(loadHistory(join(tmpdir(), "does-not-exist.jsonl"))).toEqual([]);
  });

  test("appendHistory writes a single entry that loadHistory can read back", () => {
    const path = tmpHistoryPath();
    appendHistory("hello world", { path });
    const entries = loadHistory(path);
    expect(entries.length).toBe(1);
    expect(entries[0]?.p).toBe("hello world");
    expect(typeof entries[0]?.t).toBe("number");
  });

  test("trimmed-empty prompts are dropped", () => {
    const path = tmpHistoryPath();
    appendHistory("   ", { path });
    appendHistory("", { path });
    expect(loadHistory(path)).toEqual([]);
  });

  test("deduplicates against the most recent entry", () => {
    const path = tmpHistoryPath();
    appendHistory("same", { path });
    appendHistory("same", { path });
    expect(loadHistory(path).length).toBe(1);
  });

  test("persists the tenant when set", () => {
    const path = tmpHistoryPath();
    appendHistory("run the workflow", { path, tenant: "acme" });
    expect(loadHistory(path)[0]?.tenant).toBe("acme");
  });

  test("creates the parent directory when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-hist-deep-"));
    dirs.push(dir);
    const path = join(dir, "nested", "history.jsonl");
    appendHistory("first", { path });
    expect(loadHistory(path).length).toBe(1);
  });

  test("skips malformed lines on load", () => {
    const path = tmpHistoryPath();
    writeFileSync(
      path,
      ["not valid json", JSON.stringify({ t: Date.now(), p: "good" }), "", "{broken"].join("\n"),
    );
    const entries = loadHistory(path);
    expect(entries.length).toBe(1);
    expect(entries[0]?.p).toBe("good");
  });

  test("caps the file at MAX_HISTORY entries with FIFO eviction", () => {
    const path = tmpHistoryPath();
    // Seed with one more than MAX_HISTORY.
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      appendHistory(`prompt-${i}`, { path });
    }
    const entries = loadHistory(path);
    expect(entries.length).toBe(MAX_HISTORY);
    // Oldest 5 should have been evicted.
    expect(entries[0]?.p).toBe("prompt-5");
    expect(entries[entries.length - 1]?.p).toBe(`prompt-${MAX_HISTORY + 4}`);
    // File should actually reflect the trim (not keep the old lines).
    const raw = readFileSync(path, "utf8");
    expect(raw.split("\n").filter((l) => l.trim().length > 0).length).toBe(MAX_HISTORY);
  });
});

describe("history-store: clear + prompt ring", () => {
  test("clearHistory wipes the file", () => {
    const path = tmpHistoryPath();
    appendHistory("x", { path });
    appendHistory("y", { path });
    clearHistory(path);
    expect(loadHistory(path)).toEqual([]);
  });

  test("loadPromptRing returns prompts oldest-first", () => {
    const path = tmpHistoryPath();
    appendHistory("first", { path });
    appendHistory("second", { path });
    appendHistory("third", { path });
    expect(loadPromptRing(path)).toEqual(["first", "second", "third"]);
  });

  test("loadPromptRing filters by tenant", () => {
    const path = tmpHistoryPath();
    appendHistory("a", { path, tenant: "acme" });
    appendHistory("b", { path, tenant: "other" });
    appendHistory("c", { path }); // no tenant — kept
    expect(loadPromptRing(path, { tenant: "acme" })).toEqual(["a", "c"]);
  });

  test("loadPromptRing honors a limit", () => {
    const path = tmpHistoryPath();
    for (let i = 0; i < 5; i++) appendHistory(`p${i}`, { path });
    expect(loadPromptRing(path, { limit: 2 })).toEqual(["p3", "p4"]);
  });
});
