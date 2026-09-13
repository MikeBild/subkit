// Unit tests for the inline-run timeout race that bounds how long a wf_<slug>
// run blocks a tools/call response. Deterministic by construction: the "run"
// promises are driven by manual resolvers (never wall-clock sleeps), and the
// timeout is forced to win with timeoutMs=0 against a never-settling run.

import { describe, expect, test } from "bun:test";

import { raceInlineRun } from "./inline-timeout.ts";

describe("raceInlineRun", () => {
  test("an already-resolved run returns inline with its result (run beats the timer)", async () => {
    const outcome = await raceInlineRun(Promise.resolve({ ok: 1 }), 50_000);
    expect(outcome.timedOut).toBe(false);
    if (!outcome.timedOut) expect(outcome.result).toEqual({ ok: 1 });
  });

  test("a run still pending past the window reports a timeout and is NOT cancelled", async () => {
    let resolveRun!: (v: string) => void;
    const run = new Promise<string>((resolve) => {
      resolveRun = resolve;
    });

    // timeoutMs=0 → the timer wins on the next macrotask while `run` is still
    // pending. No wall-clock sleep in the test.
    const outcome = await raceInlineRun(run, 0);
    expect(outcome.timedOut).toBe(true);

    // The run was not cancelled — it still settles when its source completes.
    resolveRun("done");
    await expect(run).resolves.toBe("done");
  });

  test("a rejected run rejects the race (caller's try/catch handles it)", async () => {
    await expect(raceInlineRun(Promise.reject(new Error("exec failed")), 50_000)).rejects.toThrow(
      "exec failed",
    );
  });
});
