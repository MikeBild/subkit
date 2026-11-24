import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  findBlockedCallToRetry,
  mergeRunInput,
  missingRequiredFields,
  readApprovedIndices,
  readFormValues,
  replayInput,
} from "./auto-persist.ts";

describe("auto-persist core properties", () => {
  test("approved indices are sorted, unique and in range", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.integer({ min: -5, max: 20 }), fc.double(), fc.string())),
        fc.nat({ max: 15 }),
        (raw, total) => {
          const out = readApprovedIndices({ approved_indices: raw }, total) ?? [];
          expect(out).toStrictEqual([...new Set(out)].sort((a, b) => a - b));
          for (const n of out) {
            expect(Number.isInteger(n) && n >= 0 && n < total).toBe(true);
            expect(raw).toContain(n);
          }
        },
      ),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("form values are always a plain object", () => {
    fc.assert(
      fc.property(fc.anything(), (output) => {
        const values = readFormValues(output);
        expect(typeof values === "object" && values !== null && !Array.isArray(values)).toBe(true);
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("submitted answers win over partial input and file input", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.integer()),
        fc.dictionary(fc.string(), fc.integer()),
        fc.dictionary(fc.string(), fc.integer()),
        (fileInput, partial, answers) => {
          const merged = mergeRunInput(partial, fileInput, partial, answers) as Record<
            string,
            unknown
          >;
          for (const [k, v] of Object.entries(answers)) expect(merged[k]).toBe(v);
        },
      ),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("missing fields are a subset of the required fields in order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "b", "c", "d")),
        fc.dictionary(
          fc.constantFrom("a", "b", "c", "d"),
          fc.oneof(fc.constant(null), fc.constant(" "), fc.string(), fc.integer()),
        ),
        (required, input) => {
          const missing = missingRequiredFields(required, input);
          expect(missing).toStrictEqual(required.filter((k) => missing.includes(k)));
        },
      ),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("replay input is null exactly when there are no args", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (args) => {
        expect(replayInput(args) === undefined).toBe(Object.keys(args).length === 0);
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("a blocked call is never a different connector", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            tool: fc.constantFrom("call_connector", "run_workflow", "ask_user_form"),
            input: fc.record({ connector_id: fc.constantFrom("a", "b") }),
            output: fc.record({ error_code: fc.constantFrom("auth_failed", "ok") }),
          }),
        ),
        (rows) => {
          const blocked = findBlockedCallToRetry(rows, "a");
          if (blocked) expect(blocked.input).toStrictEqual({ connector_id: "a" });
        },
      ),
      { seed: 20261106, numRuns: 200 },
    );
  });
});
