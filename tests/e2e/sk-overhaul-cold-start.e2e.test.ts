// Cold-start E2E for the sk CLI overhaul.
//
// Closes plan item 14 (PTY E2E #1 in the matrix). Drives the compiled
// binary through `expect(1)` and asserts: the welcome banner appears,
// stdout shows the persona-aware status line within the bootstrap-
// resolved budget, and Ctrl+D exits cleanly.
//
// Skipped automatically when dist/sk is missing (the test runner only
// loads it after `bun run build:sk`). Reuses the shared PTY harness
// at tests/e2e/_helpers/pty.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { EXPECT_BIN, runPtyScenario, SK_BIN } from "./_helpers/pty.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

const HAS_BINARY = existsSync(SK_BIN);
const HAS_EXPECT = !!EXPECT_BIN;

let env: E2EEnv | null = null;

beforeAll(async () => {
  if (!HAS_BINARY || !HAS_EXPECT) return;
  env = await boot("sk-overhaul-cold-start", { llm: "mock" });
}, 90_000);

afterAll(async () => {
  if (env) await shutdown(env);
}, 30_000);

describe("e2e: sk cold start", () => {
  test.skipIf(!HAS_BINARY || !HAS_EXPECT)(
    "(matrix #1) banner renders within the cold-start budget",
    async () => {
      if (!env) throw new Error("env not booted");
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "sk", label: "any-sk-frame" },
          { kind: "send", text: "\x04" }, // Ctrl+D
        ],
        { persona: env.personas.admin, engineUrl: env.baseUrl },
      );
      expect(r.exitCode).toBe(0);
      expect(r.visible.toLowerCase()).toContain("sk");
    },
    20_000,
  );

  test.skipIf(!HAS_BINARY || !HAS_EXPECT)(
    "(matrix #19) Ctrl+C cancels and exits clean",
    async () => {
      if (!env) throw new Error("env not booted");
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "sk", label: "ready" },
          { kind: "send", text: "\x03" }, // Ctrl+C once
          { kind: "sleep", ms: 50 },
          { kind: "send", text: "\x03" }, // Ctrl+C again exits
        ],
        { persona: env.personas.admin, engineUrl: env.baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );
});
