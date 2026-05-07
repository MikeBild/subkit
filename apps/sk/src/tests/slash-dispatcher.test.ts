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

  // R1-S2 / R2-W4 regression: the dispatcher must classify by the
  // command's `routing` field, not by raw name. If a future writer
  // adds a slash named e.g. `/audit` with `routing: "local"` the
  // engine-side audit row goes missing — this test pins that the
  // *registry* is the source, so any such mistake shows up here as
  // well as in code review.
  test("derives local routing from each command's `routing` field, not a name list", () => {
    const snap = _localOnlySnapshot();
    // Engine-routed commands must NOT appear in the local snapshot.
    for (const eng of ["audit", "connectors", "workflows", "approve", "reject"]) {
      expect(snap).not.toContain(eng);
    }
  });
});
