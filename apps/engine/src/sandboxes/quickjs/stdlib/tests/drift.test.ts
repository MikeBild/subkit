import { describe, expect, test } from "bun:test";
import { detectStdlibDrift } from "../drift.ts";
import { STDLIB_VERSION } from "../index.ts";

describe("detectStdlibDrift", () => {
  test("null / empty recorded version returns null", () => {
    expect(detectStdlibDrift(null)).toBeNull();
    expect(detectStdlibDrift(undefined)).toBeNull();
    expect(detectStdlibDrift("")).toBeNull();
  });

  test("same version returns null", () => {
    expect(detectStdlibDrift(STDLIB_VERSION)).toBeNull();
  });

  test("patch and minor diffs on the same major return null", () => {
    // Today's stdlib is 1.x. Anything under 2.x is compatible.
    expect(detectStdlibDrift("1.0.1")).toBeNull();
    expect(detectStdlibDrift("1.2.3")).toBeNull();
    expect(detectStdlibDrift("1.9.99")).toBeNull();
  });

  test("major-version gap is reported as drift", () => {
    const drift = detectStdlibDrift("0.9.0");
    expect(drift).not.toBeNull();
    expect(drift?.reason).toBe("major_bump");
    expect(drift?.recorded_major).toBe(0);
    expect(drift?.current_major).toBe(1);
    expect(drift?.recorded_version).toBe("0.9.0");
    expect(drift?.current_version).toBe(STDLIB_VERSION);
  });

  test("garbage versions return null (cannot decide)", () => {
    expect(detectStdlibDrift("not-a-version")).toBeNull();
    expect(detectStdlibDrift("xxx")).toBeNull();
  });
});
