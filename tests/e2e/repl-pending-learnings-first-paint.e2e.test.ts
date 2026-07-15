// E2E regression pin: the sk Ink REPL's pending-learnings count on FIRST
// paint (v1.14.1 fix in apps/sk/src/ink-repl.ts).
//
// The welcome banner (apps/sk/src/ink-app/welcome-row.tsx -> <StarterActions>)
// sits inside Ink's <Static> block, which flushes items ONCE and never
// re-prints an already-committed item. `runInkRepl` therefore starts the
// `fetchPendingLearningsCount` request early (`learningsPromise`) and AWAITS
// it — `bootSnapshot = { ...bootSnapshot, pendingLearnings: await
// learningsPromise }` — before <InkApp> (and its <RootApp> useState seed) is
// ever created. That guarantees the count baked into the first React render
// is already correct.
//
// The regression this test guards: moving that fetch to a fire-and-forget
// listener update (mirroring the operator-digest pattern a few lines below
// it) would leave the FIRST <Static> flush with `pendingLearnings: 0` — the
// "Review N proposed learnings" starter row would never appear, because
// Static only prints newly appended items, not edits to ones already
// flushed. All existing unit tests (starter-action-injection, welcome-row)
// stay green in that regression because they render the row directly from a
// passed-in count; only a real boot-order regression surfaces here.
//
// Drives the compiled dist/sk binary under a PTY (tests/e2e/_helpers/pty.ts)
// against a real engine (tests/e2e/setup.ts) with two seeded, proposed
// `session_learning` skill_candidates rows for the admin persona's tenant —
// the same seeding shape as
// apps/engine/src/skill-candidates/tests/list-proposed-for-authoring.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { skillCandidates } from "../../apps/engine/src/db/schema/index.ts";
import { runPtyScenario, SKIP_PTY } from "./_helpers/pty.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv | null = null;

beforeAll(async () => {
  if (SKIP_PTY) return;
  env = await boot("repl-pending-learnings-first-paint", { llm: "mock" });
  // Two proposed session-learning candidates so the injected starter row
  // reads "Review 2 proposed learnings" (starter-action-injection.ts
  // pluralizes on count !== 1) — the exact label asserted below.
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
      // The composer's `❯` glyph (apps/sk/src/ink-app/composer.tsx) sits
      // physically BELOW the <Static> welcome banner in the same JSX tree
      // (StatusBar -> Composer, after WelcomeRow's staticRows). If the
      // review row only reached the terminal via a later re-render (the
      // regression scenario), Static would never re-flush the already-
      // committed welcome item and the row would be ABSENT entirely — not
      // just late. Waiting for it directly (rather than the generic
      // quick-start banner pattern) makes a regression a loud timeout
      // instead of a silent pass.
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Review 2 proposed learnings", label: "learnings-row" },
          { kind: "send", text: "\x04" }, // Ctrl+D — clean exit
        ],
        { persona: env.personas.admin, engineUrl: env.baseUrl },
      );
      expect(r.exitCode).toBe(0);
      expect(r.visible).toContain(REVIEW_ROW);

      // Ordering guard: the review row must appear in the SAME initial
      // frame as the composer, strictly above it — proof it was part of
      // the first <Static> flush rather than a later repaint stacked on
      // top of an already-drawn composer.
      const reviewIdx = r.visible.indexOf(REVIEW_ROW);
      const composerIdx = r.visible.indexOf("❯");
      expect(reviewIdx).toBeGreaterThan(-1);
      expect(composerIdx).toBeGreaterThan(-1);
      expect(reviewIdx).toBeLessThan(composerIdx);
    },
    20_000,
  );
});
