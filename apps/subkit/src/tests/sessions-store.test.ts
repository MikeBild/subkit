import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  deleteEvents,
  loadEvents,
  scrubSecrets,
  sessionEventsPath,
  sessionsDir,
} from "../domain/sessions/store.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subkit-sessions-store-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("session JSONL store", () => {
  test("sessionsDir returns the override or the default ~/.subkit/sessions", () => {
    expect(sessionsDir("/tmp/x")).toBe("/tmp/x");
    expect(sessionsDir()).toMatch(/\.subkit\/sessions$/);
  });

  test("appendEvent + loadEvents round-trip", () => {
    appendEvent(
      "c-1",
      { seq: 0, kind: "user_message", data: { text: "hello" } },
      { dir, tenant: "t-test", now: () => new Date("2026-01-01T00:00:00Z") },
    );
    appendEvent(
      "c-1",
      { seq: 1, kind: "assistant_delta", data: { delta: "hi" } },
      { dir, tenant: "t-test" },
    );
    const events = loadEvents("c-1", dir, "t-test");
    expect(events.length).toBe(2);
    expect(events[0]?.kind).toBe("user_message");
    expect(events[0]?.ts).toBe("2026-01-01T00:00:00.000Z");
    expect(events[0]?.data).toEqual({ text: "hello" });
    expect(events[1]?.kind).toBe("assistant_delta");
  });

  test("loadEvents returns [] for an unknown conversation", () => {
    expect(loadEvents("not-real", dir, "t-test")).toEqual([]);
  });

  test("loadEvents rejects missing tenant", () => {
    expect(() => loadEvents("c-x", dir, "")).toThrow(/tenant is required/);
  });

  test("deleteEvents rejects missing tenant", () => {
    expect(() => deleteEvents("c-x", dir, "")).toThrow(/tenant is required/);
  });

  test("loadEvents skips truncated trailing lines", () => {
    appendEvent(
      "c-2",
      { seq: 0, kind: "user_message", data: { text: "ok" } },
      { dir, tenant: "t-test" },
    );
    const fs = require("node:fs") as typeof import("node:fs");
    fs.appendFileSync(sessionEventsPath("c-2", dir, "t-test"), '{"seq": 1, "kind":');
    const events = loadEvents("c-2", dir, "t-test");
    expect(events.length).toBe(1);
    expect(events[0]?.seq).toBe(0);
  });

  test("loadEvents skips rows that carry no tenant", () => {
    appendEvent(
      "c-5",
      { seq: 0, kind: "user_message", data: { text: "ok" } },
      { dir, tenant: "t-test" },
    );
    const fs = require("node:fs") as typeof import("node:fs");
    fs.appendFileSync(
      sessionEventsPath("c-5", dir, "t-test"),
      `${JSON.stringify({ seq: 1, ts: "2026-01-01T00:00:00Z", kind: "user_message", data: {} })}\n`,
    );
    const events = loadEvents("c-5", dir, "t-test");
    expect(events.map((e) => e.seq)).toEqual([0]);
  });

  test("file is mode 0600", () => {
    appendEvent("c-3", { seq: 0, kind: "user_message", data: {} }, { dir, tenant: "t-test" });
    const fs = require("node:fs") as typeof import("node:fs");
    const stat = fs.statSync(sessionEventsPath("c-3", dir, "t-test"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("appendEvent JSON-encodes the event", () => {
    appendEvent(
      "c-4",
      { seq: 0, kind: "tool_call", data: { name: "x" } },
      { dir, tenant: "t-test" },
    );
    const raw = readFileSync(sessionEventsPath("c-4", dir, "t-test"), "utf8");
    expect(raw).toMatch(/"kind":"tool_call"/);
    expect(raw).toMatch(/"name":"x"/);
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("scrubSecrets redacts strings classified as secret-shaped", () => {
    const ghToken = `ghp_${"a".repeat(40)}`;
    const out = scrubSecrets({
      input: ghToken,
      nested: { deeper: [ghToken, "harmless"] },
      plain: "hello",
    });
    expect(out).toEqual({
      input: "***redacted***",
      nested: { deeper: ["***redacted***", "harmless"] },
      plain: "hello",
    });
  });

  test("appendEvent persists redacted secrets, never the raw token", () => {
    const conv = "secret-conv";
    const ghToken = `ghp_${"b".repeat(40)}`;
    appendEvent(
      conv,
      { seq: 1, kind: "user_message", data: { text: ghToken } },
      { dir, tenant: "t-test" },
    );
    const raw = readFileSync(sessionEventsPath(conv, dir, "t-test"), "utf8");
    expect(raw).not.toContain(ghToken);
    expect(raw).toContain("***redacted***");
  });

  test("sessionEventsPath namespaces by tenant when given", () => {
    const p = sessionEventsPath("c-1", "/tmp/sk-x", "tenant-A");
    expect(p).toBe("/tmp/sk-x/tenant-A/c-1.jsonl");
  });

  test("sessionEventsPath sanitises path-traversal attempts in tenant", () => {
    const p = sessionEventsPath("c-1", "/tmp/sk-x", "../../etc");
    expect(p).toBe("/tmp/sk-x/______etc/c-1.jsonl");
  });

  test("appendEvent embeds the tenant in each event payload", () => {
    const conv = "tenant-test-conv";
    appendEvent(
      conv,
      { seq: 0, kind: "user_message", data: { text: "hi" } },
      { dir, tenant: "tenant-A" },
    );
    const events = loadEvents(conv, dir, "tenant-A");
    expect(events.length).toBe(1);
    expect(events[0]?.tenant).toBe("tenant-A");
  });

  test("two tenants writing the same conversation id get distinct files", () => {
    appendEvent(
      "shared-conv-id",
      { seq: 0, kind: "user_message", data: { text: "from-A" } },
      { dir, tenant: "tenant-A" },
    );
    appendEvent(
      "shared-conv-id",
      { seq: 0, kind: "user_message", data: { text: "from-B" } },
      { dir, tenant: "tenant-B" },
    );
    const a = loadEvents("shared-conv-id", dir, "tenant-A");
    const b = loadEvents("shared-conv-id", dir, "tenant-B");
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0]?.data).toEqual({ text: "from-A" });
    expect(b[0]?.data).toEqual({ text: "from-B" });
  });

  test("deleteEvents removes the log file", () => {
    appendEvent("c-5", { seq: 0, kind: "user_message", data: {} }, { dir, tenant: "t-test" });
    deleteEvents("c-5", dir, "t-test");
    expect(loadEvents("c-5", dir, "t-test")).toEqual([]);
  });
});
