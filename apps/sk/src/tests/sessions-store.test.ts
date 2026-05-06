import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  deleteEvents,
  loadEvents,
  sessionEventsPath,
  sessionsDir,
} from "../domain/sessions/store.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sk-sessions-store-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("session JSONL store", () => {
  test("sessionsDir returns the override or the default ~/.sk/sessions", () => {
    expect(sessionsDir("/tmp/x")).toBe("/tmp/x");
    expect(sessionsDir()).toMatch(/\.sk\/sessions$/);
  });

  test("sessionEventsPath joins {dir}/{conversationId}.jsonl", () => {
    expect(sessionEventsPath("c-123", "/tmp/x")).toBe("/tmp/x/c-123.jsonl");
  });

  test("appendEvent + loadEvents round-trip", () => {
    appendEvent(
      "c-1",
      { seq: 0, kind: "user_message", data: { text: "hello" } },
      { dir, now: () => new Date("2026-01-01T00:00:00Z") },
    );
    appendEvent("c-1", { seq: 1, kind: "assistant_delta", data: { delta: "hi" } }, { dir });
    const events = loadEvents("c-1", dir);
    expect(events.length).toBe(2);
    expect(events[0]?.kind).toBe("user_message");
    expect(events[0]?.ts).toBe("2026-01-01T00:00:00.000Z");
    expect(events[0]?.data).toEqual({ text: "hello" });
    expect(events[1]?.kind).toBe("assistant_delta");
  });

  test("loadEvents returns [] for an unknown conversation", () => {
    expect(loadEvents("not-real", dir)).toEqual([]);
  });

  test("loadEvents skips truncated trailing lines", () => {
    appendEvent("c-2", { seq: 0, kind: "user_message", data: { text: "ok" } }, { dir });
    // Append a partial line manually to simulate a crash.
    const fs = require("node:fs") as typeof import("node:fs");
    fs.appendFileSync(sessionEventsPath("c-2", dir), '{"seq": 1, "kind":');
    const events = loadEvents("c-2", dir);
    expect(events.length).toBe(1);
    expect(events[0]?.seq).toBe(0);
  });

  test("file is mode 0600", () => {
    appendEvent("c-3", { seq: 0, kind: "user_message", data: {} }, { dir });
    const fs = require("node:fs") as typeof import("node:fs");
    const stat = fs.statSync(sessionEventsPath("c-3", dir));
    // 0o600 = owner read/write only — last 9 bits should be 0o600
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("appendEvent JSON-encodes the event", () => {
    appendEvent("c-4", { seq: 0, kind: "tool_call", data: { name: "x" } }, { dir });
    const raw = readFileSync(sessionEventsPath("c-4", dir), "utf8");
    expect(raw).toMatch(/"kind":"tool_call"/);
    expect(raw).toMatch(/"name":"x"/);
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("deleteEvents removes the log file", () => {
    appendEvent("c-5", { seq: 0, kind: "user_message", data: {} }, { dir });
    deleteEvents("c-5", dir);
    expect(loadEvents("c-5", dir)).toEqual([]);
  });
});
