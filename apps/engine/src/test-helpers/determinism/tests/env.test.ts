import { describe, expect, it } from "bun:test";
import { runWithTestEnv, withTestEnv } from "../env.ts";

describe("env", () => {
  const KEY = "SUBKIT_TEST_ENV_SPEC_KEY";

  it("withTestEnv sets values and restore() puts them back", () => {
    process.env[KEY] = "original";
    const h = withTestEnv({ [KEY]: "override" });
    expect(process.env[KEY]).toBe("override");
    h.restore();
    expect(process.env[KEY]).toBe("original");
  });

  it("withTestEnv deletes keys set to undefined", () => {
    process.env[KEY] = "original";
    const h = withTestEnv({ [KEY]: undefined });
    expect(process.env[KEY]).toBeUndefined();
    h.restore();
    expect(process.env[KEY]).toBe("original");
  });

  it("withTestEnv restores absence when the key was not set", () => {
    delete process.env[KEY];
    const h = withTestEnv({ [KEY]: "added" });
    expect(process.env[KEY]).toBe("added");
    h.restore();
    expect(process.env[KEY]).toBeUndefined();
  });

  it("runWithTestEnv restores after the callback returns", async () => {
    delete process.env[KEY];
    const out = await runWithTestEnv({ [KEY]: "x" }, () => {
      expect(process.env[KEY]).toBe("x");
      return 42;
    });
    expect(out).toBe(42);
    expect(process.env[KEY]).toBeUndefined();
  });

  it("runWithTestEnv restores even if the callback throws", async () => {
    process.env[KEY] = "before";
    await expect(
      runWithTestEnv({ [KEY]: "during" }, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    expect(process.env[KEY]).toBe("before");
  });
});
