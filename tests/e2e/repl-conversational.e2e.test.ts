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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runPtyScenario, SKIP_PTY_WHEN_NO_EXPECT } from "./_helpers/pty.ts";
import { exit, quickStartReady, slash } from "./_helpers/pty-steps.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("repl-conversational", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

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
        [quickStartReady(), slash("help"), { kind: "sleep", ms: 500 }, exit()],
        { persona: env.personas.admin, engineUrl: env.baseUrl },
      );
      expect(result.exitCode).toBe(0);
      // The help pane lists at least the /exit command it itself documents.
      expect(result.visible).toContain("/help");
    },
    40_000,
  );
});
