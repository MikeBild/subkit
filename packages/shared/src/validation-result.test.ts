import { expect, test } from "bun:test";
import fc from "fast-check";
import { fail, ok } from "./validation-result.ts";

test("successful validation preserves the supplied payload, including empty values", () => {
  for (const payload of [undefined, null, false, 0, "", { name: "sample" }]) {
    const result = ok(payload);
    expect(result).toEqual({ valid: true, payload });
    if (result.valid) expect(result.payload).toBe(payload);
  }
});

test("failed validation preserves readonly structured issues without mutating them", () => {
  fc.assert(
    fc.property(fc.array(fc.record({ code: fc.string(), message: fc.string() })), (issues) => {
      const input = Object.freeze(issues.map((issue) => Object.freeze(issue)));
      const result = fail(input);
      expect(result).toEqual({ valid: false, errors: input });
      if (!result.valid) expect(result.errors).toBe(input);
      expect(Object.isFrozen(input)).toBe(true);
    }),
    { seed: 20261109, numRuns: 50 },
  );
});
