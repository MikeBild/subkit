import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  argsHashOf,
  decideArgsRepeat,
  failureSignature,
  nextErrorCodeStreak,
  REPEAT_EXEMPT_TOOLS,
  REPEAT_THRESHOLD,
  stableStringify,
  turnBudgetReached,
} from "./tool-invoke.ts";

const options = { seed: 20261106, numRuns: 200 };

function shuffleKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(shuffleKeys);
  const entries = Object.entries(value as Record<string, unknown>).reverse();
  return Object.fromEntries(entries.map(([k, v]) => [k, shuffleKeys(v)]));
}

describe("tool-invoke core properties", () => {
  test("stable stringify ignores key order and parses back to the same JSON", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const a = stableStringify(value);
        expect(stableStringify(shuffleKeys(value))).toBe(a);
        expect(JSON.parse(a)).toEqual(JSON.parse(JSON.stringify(value)));
        expect(argsHashOf(value)).toBe(a);
      }),
      options,
    );
  });

  test("read-only tools never trip and never track", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.record({ name: fc.string(), category: fc.constant("tenant_read") }),
          fc.record({ name: fc.constantFrom(...REPEAT_EXEMPT_TOOLS), category: fc.string() }),
        ),
        fc.string(),
        fc.nat(20),
        (inner, argsHash, count) => {
          const verdict = decideArgsRepeat({
            inner,
            argsHash,
            toolArgsRepeat: { hash: argsHash, count },
            lastExecutionSuccess: { tool: inner.name, args_hash: argsHash, output: 1 },
          });
          expect(verdict.isReadOnly).toBe(true);
          expect(verdict.tripped).toBe(false);
          expect(verdict.toolArgsRepeat).toBeNull();
        },
      ),
      options,
    );
  });

  test("a write tool trips exactly when the identical-args streak reaches the threshold", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.nat(20), (argsHash, count) => {
        const verdict = decideArgsRepeat({
          inner: { name: "edit_workflow_patch", category: "draft_write" },
          argsHash,
          toolArgsRepeat: { hash: argsHash, count },
          lastExecutionSuccess: null,
        });
        expect(verdict.repeatCount).toBe(count + 1);
        expect(verdict.tripped).toBe(count + 1 >= REPEAT_THRESHOLD);
      }),
      options,
    );
  });

  test("an error-code streak grows by one on a repeat and resets otherwise", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.nat(50), (prior, code, count) => {
        const next = nextErrorCodeStreak({ code: prior, count }, code);
        expect(next.code).toBe(code);
        expect(next.count).toBe(prior === code ? count + 1 : 1);
      }),
      options,
    );
  });

  test("the failure shape starts with the reason and bounds the message part", () => {
    fc.assert(
      fc.property(
        fc.record(
          { reason: fc.string(), error: fc.string(), message: fc.string() },
          { requiredKeys: [] },
        ),
        (payload) => {
          const { reason, shape } = failureSignature(payload);
          expect(shape.startsWith(`${reason}|`)).toBe(true);
          expect(shape.length - reason.length - 1).toBeLessThanOrEqual(120);
        },
      ),
      options,
    );
  });

  test("the turn budget is monotonic", () => {
    fc.assert(
      fc.property(fc.nat(100), fc.nat(100), (a, b) => {
        if (a <= b && turnBudgetReached(a)) expect(turnBudgetReached(b)).toBe(true);
      }),
      options,
    );
  });
});
