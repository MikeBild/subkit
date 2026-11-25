import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  abortTimeout,
  attachmentMimeTypesOf,
  cacheReadUsage,
  failedChecks,
  isContinuationTurn,
  PROSE_TAIL_WINDOW,
  priorFailuresFromPreview,
  scanProseChunk,
  topSkillsByTokens,
  turnBudgetMs,
  turnOutcome,
  turnTokenEstimate,
} from "./loop.ts";

describe("loop core properties", () => {
  test("short texts are always continuations", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 7 }), (text) => isContinuationTurn(text)),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("attachment mime types are the non-empty strings in order", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.string(), fc.constant(null), fc.integer())), (values) => {
        const out = attachmentMimeTypesOf(values.map((content_type) => ({ content_type })));
        expect(out).toStrictEqual(
          values.filter((v): v is string => typeof v === "string" && v !== ""),
        );
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("token estimate adds 1024 per step on top of the prompt", () => {
    fc.assert(
      fc.property(fc.nat(10_000), fc.nat(10_000), fc.nat(100), (prompt, messages, budget) => {
        const e = turnTokenEstimate(prompt, messages, budget);
        expect(e.estimatedPromptTokens).toBe(prompt + messages);
        expect(e.estimated - e.estimatedPromptTokens).toBe(budget * 1024);
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("turn budget never exceeds ten minutes and grows with the step budget", () => {
    fc.assert(
      fc.property(fc.nat(200), (budget) => {
        const ms = turnBudgetMs(budget);
        expect(ms).toBeLessThanOrEqual(600_000);
        expect(ms).toBeLessThanOrEqual(30_000 * budget);
        expect(turnBudgetMs(budget + 1)).toBeGreaterThanOrEqual(ms);
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("an unreported abort phase times out with the budget of its phase", () => {
    fc.assert(
      fc.property(fc.nat(100_000), fc.nat(100_000), fc.nat(100_000), (elapsedMs, turn, first) => {
        const t = abortTimeout({
          reportedPhase: null,
          elapsedMs,
          turnBudgetMs: turn,
          firstChunkMs: first,
        });
        expect(t.timeoutMs).toBe(t.phase === "total" ? turn : first);
        expect(t.phase === "total").toBe(elapsedMs >= turn);
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("cache read share stays between 0 and 100 percent", () => {
    fc.assert(
      fc.property(fc.nat(1_000_000), fc.nat(1_000_000), (input, cached) => {
        const u = cacheReadUsage({
          input_tokens: input,
          cache_read_tokens: cached,
          cache_creation_tokens: 0,
          cache_reported: true,
        });
        if (Math.max(input, cached) === 0) {
          expect(u).toStrictEqual({});
          return;
        }
        expect(u.cache_read_tokens).toBe(cached);
        expect(u.cache_read_pct).toBeGreaterThanOrEqual(0);
        expect(u.cache_read_pct).toBeLessThanOrEqual(100);
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("failed checks are a subset of the keys", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.oneof(fc.boolean(), fc.constant(null))),
        (checks) => {
          const failed = failedChecks(checks);
          for (const key of failed) expect(checks[key]).toBe(false);
          expect(failed.length).toBe(Object.values(checks).filter((v) => v === false).length);
        },
      ),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("preview failures keep at most ten warnings in order", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ step_key: fc.string() }), { maxLength: 30 }), (warnings) => {
        const out = priorFailuresFromPreview(warnings);
        expect(out.map((f) => f.step_id)).toStrictEqual(
          warnings.slice(0, 10).map((w) => w.step_key),
        );
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("the prose tail never exceeds its window and the scan stays inside it", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: fc.constantFrom("a", " ", "\n"), maxLength: 3000 }), {
          maxLength: 6,
        }),
        (chunks) => {
          let scan = { tail: "", scanFrom: 0, paragraphs: 0 };
          for (const chunk of chunks) {
            const before = scan.paragraphs;
            const step = scanProseChunk(scan, chunk);
            scan = step.scan;
            expect(scan.tail.length).toBeLessThanOrEqual(PROSE_TAIL_WINDOW);
            expect(scan.scanFrom).toBeLessThanOrEqual(scan.tail.length);
            expect(scan.paragraphs - before).toBeLessThanOrEqual(1);
            expect(step.progressLabel !== null).toBe(
              scan.paragraphs > before && scan.paragraphs >= 2,
            );
          }
        },
      ),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("top skills are sorted descending and hold at most five entries", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ id: fc.uuid(), w: fc.nat(1000) }), {
          selector: (s) => s.id,
          maxLength: 12,
        }),
        (skills) => {
          const out = topSkillsByTokens(skills, 0, (s) => s.w);
          if (skills.length === 0) {
            expect(out).toBeNull();
            return;
          }
          const tokens = (out ?? []).map((s) => s.tokens);
          expect(tokens.length).toBe(Math.min(5, skills.length));
          expect(tokens).toStrictEqual([...tokens].sort((a, b) => b - a));
        },
      ),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("only active outcomes can be parked", () => {
    fc.assert(
      fc.property(
        fc.record({
          cancelled: fc.boolean(),
          persistedStatus: fc.constantFrom(null, "active", "abandoned", "awaiting_input"),
          cancelledByConversation: fc.boolean(),
          committedWorkflowId: fc.constantFrom(null, "wf"),
          savedInertDraft: fc.boolean(),
          pendingElicitationId: fc.constantFrom(undefined, "el"),
          hasPendingElicitation: fc.boolean(),
        }),
        (input) => {
          const outcome = turnOutcome(input);
          expect(outcome.parkable).toBe(
            outcome.status === "active" && !outcome.committed_workflow_id,
          );
          if (input.cancelled || input.cancelledByConversation) {
            expect(outcome.status).toBe("abandoned");
          }
        },
      ),
      { seed: 20261106, numRuns: 200 },
    );
  });
});
