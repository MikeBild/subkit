import { describe, expect, test } from "bun:test";
import { EngineError, TransportError } from "@cli-core/errors";
import { savedAwaitingRestart, shadowWarning, writeTarget } from "./settings.ts";

describe("sk settings set — a value that waits for a restart", () => {
  test("is a save, not a failure", () => {
    const answer = new EngineError(409, {
      code: "restart_required",
      message:
        "errors.ring_size was saved as revision 3 and becomes active with the next process restart",
    });
    expect(savedAwaitingRestart(answer)).toContain("saved as revision 3");
  });

  test("every other answer stays an error", () => {
    expect(
      savedAwaitingRestart(new EngineError(409, { code: "conflict", message: "x" })),
    ).toBeNull();
    expect(savedAwaitingRestart(new TransportError(new Error("ECONNREFUSED")))).toBeNull();
    expect(savedAwaitingRestart(new Error("boom"))).toBeNull();
  });
});

describe("sk settings set — where a value lands", () => {
  test("names the engine and the scope it was written to", () => {
    expect(writeTarget("https://a.example", undefined)).toBe("https://a.example · engine-wide");
    expect(writeTarget("https://a.example", "t1")).toBe("https://a.example · workspace t1");
  });

  test("warns when a workspace value overrides an engine-wide write", () => {
    expect(shadowWarning(undefined, "t1", "tenant")).toContain("--tenant t1");
    expect(shadowWarning(undefined, "t1", "global")).toBeNull();
    expect(shadowWarning("t1", "t1", "tenant")).toBeNull();
    expect(shadowWarning(undefined, null, "tenant")).toBeNull();
  });
});
