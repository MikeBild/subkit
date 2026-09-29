import { describe, expect, test } from "bun:test";
import { EngineError, TransportError } from "@cli-core/errors";
import { savedAwaitingRestart } from "./settings.ts";

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
