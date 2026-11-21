import { describe, expect, it } from "bun:test";
import { runWithTestEnv, testEnv, withTestEnv } from "../env.ts";

describe("env", () => {
  const KEY = "SUBKIT_TEST_ENV_SPEC_KEY";

  it("withTestEnv sets values and restore() puts them back", () => {
    testEnv[KEY] = "original";
    const h = withTestEnv({ [KEY]: "override" });
    expect(testEnv[KEY]).toBe("override");
    h.restore();
    expect(testEnv[KEY]).toBe("original");
  });

  it("withTestEnv deletes keys set to undefined", () => {
    testEnv[KEY] = "original";
    const h = withTestEnv({ [KEY]: undefined });
    expect(testEnv[KEY]).toBeUndefined();
    h.restore();
    expect(testEnv[KEY]).toBe("original");
  });

  it("withTestEnv restores absence when the key was not set", () => {
    delete testEnv[KEY];
    const h = withTestEnv({ [KEY]: "added" });
    expect(testEnv[KEY]).toBe("added");
    h.restore();
    expect(testEnv[KEY]).toBeUndefined();
  });

  it("runWithTestEnv restores after the callback returns", async () => {
    delete testEnv[KEY];
    const out = await runWithTestEnv({ [KEY]: "x" }, () => {
      expect(testEnv[KEY]).toBe("x");
      return 42;
    });
    expect(out).toBe(42);
    expect(testEnv[KEY]).toBeUndefined();
  });

  it("runWithTestEnv restores even if the callback throws", async () => {
    testEnv[KEY] = "before";
    await expect(
      runWithTestEnv({ [KEY]: "during" }, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    expect(testEnv[KEY]).toBe("before");
  });
});
