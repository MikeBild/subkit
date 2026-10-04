import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { skillCandidates } from "../../apps/engine/src/db/schema/index.ts";
import { runPtyScenario, SKIP_PTY } from "./_helpers/pty.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv | null = null;

beforeAll(async () => {
  if (SKIP_PTY) return;
  env = await boot("repl-pending-learnings-first-paint", { llm: "mock" });
  for (let i = 0; i < 2; i++) {
    await env.db.insert(skillCandidates).values({
      tenant_id: env.tenantId,
      scope: "global",
      pattern_kind: "session_learning",
      title: `Session learning candidate ${i}`,
      body: `Body for candidate ${i}`,
      examples: null,
      evidence: [],
      confidence: "medium",
      status: "proposed",
      fingerprint: `repl-first-paint-${i}`,
    });
  }
}, 90_000);

afterAll(async () => {
  await shutdown(env ?? undefined);
}, 30_000);

describe("e2e: sk REPL pending-learnings first paint", () => {
  test.skipIf(SKIP_PTY)(
    "the flushed welcome banner already shows the review-learnings row on first paint",
    async () => {
      if (!env) throw new Error("env not booted");
      const REVIEW_ROW = "Review 2 proposed learnings";
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Review 2 proposed learnings", label: "learnings-row" },
          { kind: "send", text: "\x04" },
        ],
        { persona: env.personas.admin, engineUrl: env.baseUrl },
      );
      expect(r.exitCode).toBe(0);
      expect(r.visible).toContain(REVIEW_ROW);
    },
    20_000,
  );
});
