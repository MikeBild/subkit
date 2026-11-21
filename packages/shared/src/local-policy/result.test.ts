import { describe, expect, test } from "bun:test";
import { ALLOW, refuse } from "./result.ts";

describe("policy results", () => {
  test("allow is a frozen ok and a refusal carries its code", () => {
    expect(ALLOW).toEqual({ ok: true });
    expect(Object.isFrozen(ALLOW)).toBe(true);
    expect(refuse("stale")).toEqual({ ok: false, code: "stale" });
  });
});
