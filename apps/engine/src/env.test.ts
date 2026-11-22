import { describe, expect, test } from "bun:test";
import { envFlag, envInt, envList, envSnapshot, isEnvKey, readEnv, validateEnv } from "./env.ts";
import { runWithTestEnv, TEST_MASTER_KEY } from "./test-helpers/determinism/env.ts";

describe("readEnv", () => {
  test("reads the live value, so a later override is visible", async () => {
    await runWithTestEnv({ DATABASE_URL: "postgres://a" }, () =>
      expect(readEnv("DATABASE_URL")).toBe("postgres://a"),
    );
    await runWithTestEnv({ DATABASE_URL: "postgres://b" }, () =>
      expect(readEnv("DATABASE_URL")).toBe("postgres://b"),
    );
  });

  test("treats an empty value as unset", async () => {
    await runWithTestEnv({ SUBKIT_REPLICA_ID: "" }, () =>
      expect(readEnv("SUBKIT_REPLICA_ID")).toBeUndefined(),
    );
  });
});

describe("envInt", () => {
  test("returns the fallback when unset, empty, non-numeric, zero or negative", async () => {
    for (const value of [undefined, "", "not-a-number", "0", "-5"]) {
      await runWithTestEnv({ SUBKIT_LOG_RING_SIZE: value }, () =>
        expect(envInt("SUBKIT_LOG_RING_SIZE", 42)).toBe(42),
      );
    }
  });

  test("returns the floored integer when set", async () => {
    await runWithTestEnv({ SUBKIT_LOG_RING_SIZE: "100.9" }, () =>
      expect(envInt("SUBKIT_LOG_RING_SIZE", 42)).toBe(100),
    );
  });
});

describe("envList", () => {
  test("splits, trims and drops empty parts", async () => {
    await runWithTestEnv({ DOCS_CRAWL_NEGATIVE: " a, ,b ,c" }, () =>
      expect(envList("DOCS_CRAWL_NEGATIVE", ["x"])).toEqual(["a", "b", "c"]),
    );
  });

  test("returns the fallback when unset or only separators", async () => {
    for (const value of [undefined, "", " , ,"]) {
      await runWithTestEnv({ DOCS_CRAWL_NEGATIVE: value }, () =>
        expect(envList("DOCS_CRAWL_NEGATIVE", ["x"])).toEqual(["x"]),
      );
    }
  });
});

describe("envFlag", () => {
  test("is true only for 1", async () => {
    for (const [value, expected] of [
      ["1", true],
      ["true", false],
      ["0", false],
      [undefined, false],
    ] as const) {
      await runWithTestEnv({ SUBKIT_DIAGNOSTICS: value }, () =>
        expect(envFlag("SUBKIT_DIAGNOSTICS")).toBe(expected),
      );
    }
  });
});

describe("envSnapshot and isEnvKey", () => {
  test("holds only declared keys with a value", async () => {
    await runWithTestEnv({ SUBKIT_LOCAL_PORT: "4100", __SUBKIT_UNDECLARED__: "x" }, () => {
      const snapshot = envSnapshot();
      expect(snapshot.SUBKIT_LOCAL_PORT).toBe("4100");
      expect(Object.hasOwn(snapshot, "__SUBKIT_UNDECLARED__")).toBe(false);
    });
  });

  test("isEnvKey knows the schema", () => {
    expect(isEnvKey("OPENAI_API_KEY")).toBe(true);
    expect(isEnvKey("__SUBKIT_UNDECLARED__")).toBe(false);
  });
});

describe("validateEnv", () => {
  test("accepts a valid boot environment", async () => {
    await runWithTestEnv({ MASTER_KEY: TEST_MASTER_KEY, NODE_ENV: "test" }, () =>
      expect(() => validateEnv()).not.toThrow(),
    );
  });

  test("refuses a missing or malformed master key and an unknown NODE_ENV", async () => {
    await runWithTestEnv({ MASTER_KEY: undefined }, () =>
      expect(() => validateEnv()).toThrow(/MASTER_KEY/),
    );
    await runWithTestEnv({ MASTER_KEY: "abc" }, () =>
      expect(() => validateEnv()).toThrow(/64 hex chars/),
    );
    await runWithTestEnv({ MASTER_KEY: TEST_MASTER_KEY, NODE_ENV: "staging" }, () =>
      expect(() => validateEnv()).toThrow(/NODE_ENV/),
    );
    await runWithTestEnv({ MASTER_KEY: TEST_MASTER_KEY, PORT: "99999" }, () =>
      expect(() => validateEnv()).toThrow(/PORT/),
    );
  });
});
