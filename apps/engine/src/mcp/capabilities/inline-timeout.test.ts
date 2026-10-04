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

    const outcome = await raceInlineRun(run, 0);
    expect(outcome.timedOut).toBe(true);

    resolveRun("done");
    await expect(run).resolves.toBe("done");
  });

  test("a rejected run rejects the race (caller's try/catch handles it)", async () => {
    await expect(raceInlineRun(Promise.reject(new Error("exec failed")), 50_000)).rejects.toThrow(
      "exec failed",
    );
  });
});
