import { describe, expect, test } from "bun:test";
import {
  currentUpdateCheck,
  descriptorVersion,
  isNewer,
  needsCheck,
  parseUpdateCheck,
  parseVersion,
  type UpdateCheck,
  type UpdateCheckDeps,
  updateCheckIntervalMs,
  updateNotice,
  updatesItself,
} from "./update.ts";

const engineUrl = "https://engine.example";

describe("parseVersion", () => {
  test("reads three numbers with an optional v and suffix", () => {
    expect(parseVersion("12.1.0")).toEqual([12, 1, 0]);
    expect(parseVersion(" v12.10.3 ")).toEqual([12, 10, 3]);
    expect(parseVersion("12.1.0-beta.1")).toEqual([12, 1, 0]);
  });

  test("rejects anything else", () => {
    expect(parseVersion("12.1")).toBeUndefined();
    expect(parseVersion("latest")).toBeUndefined();
    expect(parseVersion(12)).toBeUndefined();
  });
});

describe("isNewer", () => {
  test("compares major, minor and patch numerically", () => {
    expect(isNewer("12.1.0", "12.0.9")).toBe(true);
    expect(isNewer("12.10.0", "12.9.0")).toBe(true);
    expect(isNewer("13.0.0", "12.99.99")).toBe(true);
    expect(isNewer("12.0.1", "12.0.0")).toBe(true);
  });

  test("is false for the same or an older version", () => {
    expect(isNewer("12.1.0", "12.1.0")).toBe(false);
    expect(isNewer("12.1.0-beta.1", "12.1.0")).toBe(false);
    expect(isNewer("11.9.0", "12.0.0")).toBe(false);
    expect(isNewer("0.0.0-dev", "12.0.0")).toBe(false);
  });

  test("is false when either side is not a version", () => {
    expect(isNewer("dev", "12.0.0")).toBe(false);
    expect(isNewer("12.1.0", "")).toBe(false);
  });
});

describe("updatesItself", () => {
  test("is true for store and policy installs only", () => {
    expect(updatesItself("normal")).toBe(true);
    expect(updatesItself("admin")).toBe(true);
    expect(updatesItself("development")).toBe(false);
    expect(updatesItself("sideload")).toBe(false);
    expect(updatesItself(undefined)).toBe(false);
  });
});

describe("descriptorVersion", () => {
  test("reads the engine version from the service descriptor", () => {
    expect(descriptorVersion({ version: "12.1.0", clients: {} })).toBe("12.1.0");
    expect(descriptorVersion({ version: "v12.1.0" })).toBe("12.1.0");
  });

  test("returns null for a missing or malformed version", () => {
    expect(descriptorVersion({})).toBeNull();
    expect(descriptorVersion({ version: "unknown" })).toBeNull();
    expect(descriptorVersion(null)).toBeNull();
    expect(descriptorVersion("12.1.0")).toBeNull();
  });
});

describe("parseUpdateCheck", () => {
  test("accepts a stored check", () => {
    expect(parseUpdateCheck({ engineUrl, checkedAt: 5, version: "12.1.0" })).toEqual({
      engineUrl,
      checkedAt: 5,
      version: "12.1.0",
    });
    expect(parseUpdateCheck({ engineUrl, checkedAt: 5 })).toEqual({
      engineUrl,
      checkedAt: 5,
      version: null,
    });
  });

  test("rejects anything else", () => {
    expect(parseUpdateCheck(undefined)).toBeUndefined();
    expect(parseUpdateCheck({ engineUrl, checkedAt: "5" })).toBeUndefined();
    expect(parseUpdateCheck({ checkedAt: 5 })).toBeUndefined();
  });
});

describe("needsCheck", () => {
  const previous: UpdateCheck = { engineUrl, checkedAt: 1_000, version: "12.1.0" };

  test("checks when nothing is stored or the engine changed", () => {
    expect(needsCheck(undefined, engineUrl, 1_000)).toBe(true);
    expect(needsCheck(previous, "https://other.example", 1_001)).toBe(true);
  });

  test("checks once a day", () => {
    expect(needsCheck(previous, engineUrl, 1_000 + updateCheckIntervalMs - 1)).toBe(false);
    expect(needsCheck(previous, engineUrl, 1_000 + updateCheckIntervalMs)).toBe(true);
  });

  test("checks again when the clock went backwards", () => {
    expect(needsCheck(previous, engineUrl, 999)).toBe(true);
  });
});

describe("updateNotice", () => {
  const check: UpdateCheck = { engineUrl, checkedAt: 1, version: "12.1.0" };

  test("offers the engine's download when the engine is newer", () => {
    expect(updateNotice({ installed: "12.0.0", installType: "development", check })).toEqual({
      version: "12.1.0",
      downloadUrl: "https://engine.example/install/clipper.zip",
    });
  });

  test("stays quiet when Chrome updates the extension itself", () => {
    expect(updateNotice({ installed: "12.0.0", installType: "normal", check })).toBeUndefined();
    expect(updateNotice({ installed: "12.0.0", installType: "admin", check })).toBeUndefined();
  });

  test("stays quiet when the extension is current or nothing is known", () => {
    expect(
      updateNotice({ installed: "12.1.0", installType: "development", check }),
    ).toBeUndefined();
    expect(
      updateNotice({ installed: "12.0.0", installType: "development", check: undefined }),
    ).toBeUndefined();
    expect(
      updateNotice({
        installed: "12.0.0",
        installType: "development",
        check: { ...check, version: null },
      }),
    ).toBeUndefined();
  });
});

function deps(stored: unknown, descriptor: () => Promise<unknown>, now = 10) {
  const writes: UpdateCheck[] = [];
  const urls: string[] = [];
  const value: UpdateCheckDeps = {
    load: async () => stored,
    store: async (check) => {
      writes.push(check);
    },
    fetchDescriptor: async (url) => {
      urls.push(url);
      return descriptor();
    },
    now: () => now,
  };
  return { value, writes, urls };
}

describe("currentUpdateCheck", () => {
  test("reads the descriptor and stores the result", async () => {
    const run = deps(undefined, async () => ({ version: "12.1.0" }));
    const check = await currentUpdateCheck(engineUrl, run.value);
    expect(check).toEqual({ engineUrl, checkedAt: 10, version: "12.1.0" });
    expect(run.urls).toEqual(["https://engine.example/.well-known/service-descriptor.json"]);
    expect(run.writes).toEqual([{ engineUrl, checkedAt: 10, version: "12.1.0" }]);
  });

  test("reuses a fresh check without a request", async () => {
    const stored = { engineUrl, checkedAt: 5, version: "12.1.0" };
    const run = deps(stored, async () => ({ version: "13.0.0" }));
    expect(await currentUpdateCheck(engineUrl, run.value)).toEqual(stored);
    expect(run.urls).toEqual([]);
    expect(run.writes).toEqual([]);
  });

  test("keeps the last result for this engine when the request fails", async () => {
    const stored = { engineUrl, checkedAt: 1, version: "12.1.0" };
    const failing = async () => {
      throw new Error("offline");
    };
    const run = deps(stored, failing, 1 + updateCheckIntervalMs);
    expect(await currentUpdateCheck(engineUrl, run.value)).toEqual(stored);
    expect(run.writes).toEqual([]);
    const other = deps(stored, failing, 1 + updateCheckIntervalMs);
    expect(await currentUpdateCheck("https://other.example", other.value)).toBeUndefined();
  });
});
