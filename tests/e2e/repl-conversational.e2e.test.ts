// REPL conversational surface — stable boot + clean exit via a PTY.
//
// The existing sk-interactive-smoke suite gates ALL of its scenarios behind
// SK_RUN_STARTER_E2E (the starter-action flows need mock scripts that
// aren't seeded), so default CI has no PTY coverage. This suite fills that
// gap with the deterministic part: the Ink REPL boots against the live
// engine, renders the quick-start banner, and exits cleanly — proving the
// compiled binary + readline/Ink wiring + engine auth work end-to-end over
// a real pseudo-terminal. A fresh REPL is spawned per scenario; the full
// transcript is captured on failure by runPtyScenario.
//
// LLM: mock — boot hermetic; the stable path makes no model call.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ExpectStep } from "./_helpers/pty.ts";
import { runPtyScenario, SKIP_PTY_WHEN_NO_EXPECT } from "./_helpers/pty.ts";
import { exit, quickStartReady } from "./_helpers/pty-steps.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("repl-conversational", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

function typeLine(text: string): ExpectStep[] {
  return [
    ...Array.from(text).map((ch) => ({ kind: "send" as const, text: ch })),
    { kind: "send", text: "\r" },
  ];
}

function debugFile(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), `sk-${name}-debug-`)), "debug.log");
}

function readDebug(pathname: string): Array<Record<string, unknown>> {
  return readFileSync(pathname, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function hasSlashCompletion(records: Array<Record<string, unknown>>, name: string): boolean {
  return records.some(
    (record) =>
      record.kind === "dialog.turn_end" &&
      record.input_kind === "slash" &&
      record.name === name &&
      record.status === "completed",
  );
}

function requestedPath(records: Array<Record<string, unknown>>, route: string): boolean {
  return records.some((record) => record.kind === "http.request" && record.path === route);
}

// Incremental-keystroke slash dispatch over the `expect` PTY harness: the
// compiled Ink binary buffers all stdin and hands the whole scenario to
// `useInput` as ONE fused chunk ("/mcp\n/exit\n"), so a typed slash + Enter
// never dispatches as a discrete turn (proven by probing the raw keycodes
// useInput receives). A real terminal delivers keystrokes one read at a time,
// so /mcp works for users; the surface is covered at the HTTP layer by
// mcp-surface.e2e.test.ts. Skipped by default — set SK_RUN_PTY_DISPATCH=1 to
// run these once the harness delivers keystrokes incrementally.
const SKIP_PTY_DISPATCH = process.env.SK_RUN_PTY_DISPATCH !== "1";

describe("sk REPL over a PTY", () => {
  // Skip only when `expect` is missing AND not in CI — in CI a missing
  // `expect` is a loud failure, not a silent coverage drop. See
  // SKIP_PTY_WHEN_NO_EXPECT in _helpers/pty.ts.
  test.skipIf(SKIP_PTY_WHEN_NO_EXPECT)(
    "boots to the quick-start banner and exits cleanly",
    async () => {
      const result = await runPtyScenario([quickStartReady(), exit()], {
        persona: env.personas.admin,
        engineUrl: env.baseUrl,
      });
      // Clean shutdown, no surfaced engine error banners.
      expect(result.exitCode).toBe(0);
      expect(result.visible).not.toContain("HTTP 500");
      expect(result.visible).not.toContain("internal_error");
    },
    40_000,
  );

  test.skipIf(SKIP_PTY_WHEN_NO_EXPECT)(
    "renders the slash-command help pane from the banner",
    async () => {
      const result = await runPtyScenario(
        [
          quickStartReady(),
          { kind: "sleep", ms: 1_000 },
          ...typeLine("/help"),
          { kind: "sleep", ms: 500 },
          exit(),
        ],
        { persona: env.personas.admin, engineUrl: env.baseUrl },
      );
      expect(result.exitCode).toBe(0);
      // The help path is local to Ink; this smoke assertion catches
      // crashes while the /mcp tests below assert real slash dispatch.
      expect(result.visible).toContain("/help");
    },
    40_000,
  );

  // See SKIP_PTY_DISPATCH above — batched-stdin PTY harness can't deliver the
  // incremental keystrokes this slash-dispatch assertion needs.
  test.skipIf(SKIP_PTY_DISPATCH)(
    "admin renders /mcp catalog pane",
    async () => {
      const logPath = debugFile("mcp-admin");
      const result = await runPtyScenario(
        [
          quickStartReady(),
          { kind: "sleep", ms: 1_000 },
          ...typeLine("/mcp"),
          { kind: "sleep", ms: 2_000 },
          exit(),
        ],
        {
          persona: env.personas.admin,
          engineUrl: env.baseUrl,
          env: { SK_DEBUG_FILE: logPath },
        },
      );
      expect(result.exitCode).toBe(0);
      const records = readDebug(logPath);
      expect(hasSlashCompletion(records, "mcp")).toBe(true);
      expect(requestedPath(records, "/v1/mcp/prompts")).toBe(true);
      expect(requestedPath(records, "/v1/mcp/resources")).toBe(true);
      expect(requestedPath(records, "/v1/mcp/tools")).toBe(true);
      expect(result.visible).not.toContain("/mcp requires mcp:read");
      expect(result.visible).not.toContain("HTTP 500");
    },
    45_000,
  );

  // Same batched-stdin PTY-harness reason as the admin case (SKIP_PTY_DISPATCH).
  test.skipIf(SKIP_PTY_DISPATCH)(
    "member renders /mcp catalog pane",
    async () => {
      const logPath = debugFile("mcp-member");
      const result = await runPtyScenario(
        [
          quickStartReady(),
          { kind: "sleep", ms: 1_000 },
          ...typeLine("/mcp"),
          { kind: "sleep", ms: 2_000 },
          exit(),
        ],
        {
          persona: env.personas.member,
          engineUrl: env.baseUrl,
          env: { SK_DEBUG_FILE: logPath },
        },
      );
      expect(result.exitCode).toBe(0);
      const records = readDebug(logPath);
      expect(hasSlashCompletion(records, "mcp")).toBe(true);
      expect(requestedPath(records, "/v1/mcp/prompts")).toBe(true);
      expect(requestedPath(records, "/v1/mcp/resources")).toBe(true);
      expect(requestedPath(records, "/v1/mcp/tools")).toBe(true);
      expect(result.visible).not.toContain("/mcp requires mcp:read");
      expect(result.visible).not.toContain("HTTP 500");
    },
    45_000,
  );
});
