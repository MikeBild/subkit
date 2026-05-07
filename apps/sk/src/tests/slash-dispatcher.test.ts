import { describe, expect, test } from "bun:test";
import { _localOnlySnapshot, classifySlash } from "../repl/slash/dispatcher.ts";

describe("classifySlash", () => {
  test("/help routes locally", () => {
    expect(classifySlash("help").routing).toBe("local");
  });

  test("/clear routes locally", () => {
    expect(classifySlash("clear").routing).toBe("local");
  });

  test("/audit routes through the engine (audit row required)", () => {
    expect(classifySlash("audit").routing).toBe("engine");
  });

  test("/connector routes through the engine (state-mutating)", () => {
    expect(classifySlash("connector").routing).toBe("engine");
  });

  test("unknown commands resolve to `unknown`", () => {
    expect(classifySlash("definitely-not-a-cmd").routing).toBe("unknown");
  });

  test("local-only set is non-empty and includes the canonical reads", () => {
    const snap = _localOnlySnapshot();
    expect(snap.length).toBeGreaterThan(0);
    expect(snap).toContain("help");
    expect(snap).toContain("clear");
  });
});
