import { describe, expect, test } from "bun:test";
import { appendCrash, CRASH_LIMIT, crashEntry, isCrash, parseCrashes } from "./crashes.ts";

const AT = "2026-11-22T10:00:00.000Z";

describe("crashes", () => {
  test("clean exits and kills are not crashes", () => {
    expect(isCrash({ reason: "clean-exit" })).toBe(false);
    expect(isCrash({ reason: "killed" })).toBe(false);
    expect(isCrash({ reason: "crashed", exitCode: 11 })).toBe(true);
    expect(isCrash({ reason: "oom" })).toBe(true);
  });

  test("an entry names the process, reason and exit code", () => {
    expect(
      crashEntry(
        "child",
        { reason: "crashed", exitCode: 9, type: "Utility", serviceName: "runner" },
        AT,
      ),
    ).toEqual({ at: AT, source: "child", process: "runner", reason: "crashed", exitCode: 9 });
    expect(crashEntry("gpu", { reason: "launch-failed", type: "GPU" }, AT).exitCode).toBeNull();
    expect(crashEntry("renderer", { reason: "oom" }, AT, "app://connect/").process).toBe(
      "app://connect/",
    );
  });

  test("keeps the most recent crashes", () => {
    let list = parseCrashes(null);
    for (let i = 0; i < CRASH_LIMIT + 3; i++)
      list = appendCrash(list, crashEntry("renderer", { reason: `r${i}` }, AT));
    expect(list).toHaveLength(CRASH_LIMIT);
    expect(list[0]?.reason).toBe("r3");
  });

  test("drops malformed stored entries", () => {
    expect(
      parseCrashes([
        { at: AT, source: "gpu", process: "GPU", reason: "crashed", exitCode: 1 },
        { at: AT, source: "nope", process: "x", reason: "y" },
        "junk",
      ]),
    ).toEqual([{ at: AT, source: "gpu", process: "GPU", reason: "crashed", exitCode: 1 }]);
  });
});
