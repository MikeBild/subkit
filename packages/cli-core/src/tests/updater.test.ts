import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkForUpdate,
  defaultUpdaterConfig,
  formatUpdateBanner,
  isNewer,
  parseChecksum,
  platformArch,
  readCache,
  type UpdateCache,
  type UpdateInfo,
  writeCache,
} from "../updater.ts";
import {
  makeCacheDir,
  makeConfig,
  makeFetchImpl,
  makeGitHubResponse,
  TEST_NOW_MS,
  useUpdaterTmpDir,
} from "./updater-fixtures.ts";

useUpdaterTmpDir();

describe("isNewer", () => {
  test("returns false for equal versions", () => {
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
  });

  test("returns true when remote major is greater", () => {
    expect(isNewer("2.0.0", "1.0.0")).toBe(true);
  });

  test("returns true when remote minor is greater", () => {
    expect(isNewer("1.3.0", "1.2.0")).toBe(true);
  });

  test("returns true when remote patch is greater", () => {
    expect(isNewer("1.2.4", "1.2.3")).toBe(true);
  });

  test("returns false when remote major is lower", () => {
    expect(isNewer("0.9.0", "1.0.0")).toBe(false);
  });

  test("returns false when remote minor is lower", () => {
    expect(isNewer("1.1.0", "1.2.0")).toBe(false);
  });

  test("returns false when remote patch is lower", () => {
    expect(isNewer("1.2.2", "1.2.3")).toBe(false);
  });

  test("handles versions with missing parts", () => {
    expect(isNewer("1.2", "1.2.0")).toBe(false);
    expect(isNewer("1.3", "1.2.0")).toBe(true);
  });

  test("handles 0.0.0 as local (always outdated for any real version)", () => {
    expect(isNewer("0.1.0", "0.0.0")).toBe(true);
  });

  test("handles large version numbers", () => {
    expect(isNewer("100.200.300", "1.2.3")).toBe(true);
    expect(isNewer("1.2.3", "100.200.300")).toBe(false);
  });
});

describe("platformArch", () => {
  test("returns os/arch/ext for current platform", () => {
    const result = platformArch();
    expect(result).not.toBeNull();
    expect(result!.os).toBeDefined();
    expect(result!.arch).toBeDefined();
    expect(typeof result!.ext).toBe("string");
  });

  test("returns empty ext for non-windows", () => {
    const result = platformArch();
    if (process.platform !== "win32") {
      expect(result!.ext).toBe("");
    }
  });

  test("os matches expected mapping for current platform", () => {
    const result = platformArch();
    if (!result) return;
    const expected: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
    expect(result.os).toBe(expected[process.platform]!);
  });
});

describe("parseChecksum", () => {
  test("rejects repeated or malformed entries for the requested asset", () => {
    const hash = "a".repeat(64);
    const other = "b".repeat(64);
    for (const second of [hash, other, "invalid"])
      expect(parseChecksum(`${hash}  LICENSE\n${second}  LICENSE\n`, "LICENSE")).toBeNull();
    expect(parseChecksum(`invalid  LICENSE\n${hash}  LICENSE\n`, "LICENSE")).toBeNull();
    expect(parseChecksum(`invalid  other\n${hash}  LICENSE\n`, "LICENSE")).toBe(hash);
  });

  const hash64 = "a".repeat(64);
  const hash64b = "b".repeat(64);

  test("extracts hash for matching asset name", () => {
    const sums = `${hash64}  sk_darwin_arm64\n`;
    expect(parseChecksum(sums, "sk_darwin_arm64")).toBe(hash64);
  });

  test("returns null when asset not found", () => {
    const sums = `${hash64}  sk_darwin_arm64\n`;
    expect(parseChecksum(sums, "sk_linux_x64")).toBeNull();
  });

  test("handles multiple entries", () => {
    const sums = `${hash64}  sk_darwin_arm64\n${hash64b}  sk_linux_x64\n`;
    expect(parseChecksum(sums, "sk_linux_x64")).toBe(hash64b);
    expect(parseChecksum(sums, "sk_darwin_arm64")).toBe(hash64);
  });

  test("handles empty file", () => {
    expect(parseChecksum("", "sk_darwin_arm64")).toBeNull();
  });

  test("handles extra whitespace and blank lines", () => {
    const sums = `\n  \n${hash64}  sk_darwin_arm64\n\n`;
    expect(parseChecksum(sums, "sk_darwin_arm64")).toBe(hash64);
  });
});

describe("formatUpdateBanner", () => {
  test("includes version number", () => {
    const info: UpdateInfo = { version: "2.0.0", tag: "v2.0.0", assets: [], body: "" };
    const banner = formatUpdateBanner(info, "sk");
    expect(banner).toContain("2.0.0");
  });

  test("includes binary name in command suggestion", () => {
    const info: UpdateInfo = { version: "2.0.0", tag: "v2.0.0", assets: [], body: "" };
    const banner = formatUpdateBanner(info, "subkit");
    expect(banner).toContain("subkit update");
  });
});

describe("defaultUpdaterConfig", () => {
  test("sets correct binaryName and repo", () => {
    const cfg = defaultUpdaterConfig("sk", "1.0.0");
    expect(cfg.binaryName).toBe("sk");
    expect(cfg.githubRepo).toBe("mikebild/subkit");
  });

  test("sets 24h check interval", () => {
    const cfg = defaultUpdaterConfig("sk", "1.0.0");
    expect(cfg.checkIntervalMs).toBe(86_400_000);
  });

  test("defaults to stable channel", () => {
    const cfg = defaultUpdaterConfig("sk", "1.0.0");
    expect(cfg.channel).toBe("stable");
  });

  test("respects beta channel parameter", () => {
    const cfg = defaultUpdaterConfig("sk", "1.0.0", "beta");
    expect(cfg.channel).toBe("beta");
  });

  test("cacheDir includes binaryName", () => {
    const cfg = defaultUpdaterConfig("my-tool", "1.0.0");
    expect(cfg.cacheDir).toContain("my-tool");
  });
});

describe("cache management", () => {
  test("writeCache creates directory recursively", () => {
    const dir = join(makeCacheDir(), "deep", "nested");
    const cache: UpdateCache = {
      last_check: TEST_NOW_MS,
      latest_version: "1.0.0",
      latest_tag: "v1.0.0",
      current_version_at_check: "0.9.0",
    };
    writeCache(dir, cache);
    expect(existsSync(join(dir, "update-check.json"))).toBe(true);
  });

  test("writeCache + readCache round-trip", () => {
    const dir = makeCacheDir();
    const cache: UpdateCache = {
      last_check: 1700000000000,
      latest_version: "2.3.4",
      latest_tag: "v2.3.4",
      current_version_at_check: "1.0.0",
    };
    writeCache(dir, cache);
    const result = readCache(dir);
    expect(result).toEqual(cache);
  });

  test("readCache returns null for missing file", () => {
    const dir = makeCacheDir();
    expect(readCache(dir)).toBeNull();
  });

  test("readCache returns null for corrupt JSON", () => {
    const dir = makeCacheDir();
    writeFileSync(join(dir, "update-check.json"), "not-json{{{");
    expect(readCache(dir)).toBeNull();
  });
});

describe("checkForUpdate", () => {
  test("returns null when cache is fresh and version is current", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    writeCache(cfg.cacheDir, {
      last_check: TEST_NOW_MS,
      latest_version: "1.0.0",
      latest_tag: "v1.0.0",
      current_version_at_check: "1.0.0",
    });
    const fetchImpl = makeFetchImpl(() => {
      throw new Error("should not be called");
    });
    const result = await checkForUpdate(cfg, false, fetchImpl);
    expect(result).toBeNull();
  });

  test("returns UpdateInfo from cache when newer version cached", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    writeCache(cfg.cacheDir, {
      last_check: TEST_NOW_MS,
      latest_version: "2.0.0",
      latest_tag: "v2.0.0",
      current_version_at_check: "1.0.0",
    });
    const fetchImpl = makeFetchImpl(() => {
      throw new Error("should not be called");
    });
    const result = await checkForUpdate(cfg, false, fetchImpl);
    expect(result).not.toBeNull();
    expect(result!.version).toBe("2.0.0");
  });

  test("force=true bypasses cache", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    writeCache(cfg.cacheDir, {
      last_check: TEST_NOW_MS,
      latest_version: "1.0.0",
      latest_tag: "v1.0.0",
      current_version_at_check: "1.0.0",
    });
    let fetchCalled = false;
    const fetchImpl = makeFetchImpl(() => {
      fetchCalled = true;
      return new Response(JSON.stringify(makeGitHubResponse("v2.0.0")));
    });
    await checkForUpdate(cfg, true, fetchImpl);
    expect(fetchCalled).toBe(true);
  });

  test("returns null when remote version equals local", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fetchImpl = makeFetchImpl(
      () => new Response(JSON.stringify(makeGitHubResponse("v1.0.0"))),
    );
    const result = await checkForUpdate(cfg, true, fetchImpl);
    expect(result).toBeNull();
  });

  test("passive check (force=false) returns null on network failure — never nags", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fetchImpl = makeFetchImpl(() => {
      throw new Error("network error");
    });
    const result = await checkForUpdate(cfg, false, fetchImpl);
    expect(result).toBeNull();
  });

  test("passive check (force=false) returns null on a 404 — stays quiet", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fetchImpl = makeFetchImpl(() => new Response("not found", { status: 404 }));
    const result = await checkForUpdate(cfg, false, fetchImpl);
    expect(result).toBeNull();
  });

  test("explicit --self-update (force=true) THROWS on a network failure — surfaces the reason", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fetchImpl = makeFetchImpl(() => {
      throw new Error("network error");
    });
    await expect(checkForUpdate(cfg, true, fetchImpl)).rejects.toThrow();
  });

  test("explicit --self-update (force=true) THROWS on a 404 with a private-repo/token hint", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fetchImpl = makeFetchImpl(() => new Response("not found", { status: 404 }));
    await expect(checkForUpdate(cfg, true, fetchImpl)).rejects.toThrow(/private|GITHUB_TOKEN|404/i);
  });

  test("sends an Authorization header when authToken is set", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0", authToken: "test-token-123" });
    let sawAuth: string | null = null;
    const fetchImpl = makeFetchImpl((_url, init) => {
      sawAuth = new Headers(init!.headers as HeadersInit).get("authorization");
      return new Response(JSON.stringify(makeGitHubResponse("v2.0.0")));
    });
    await checkForUpdate(cfg, true, fetchImpl);
    expect(sawAuth as string | null).toBe("Bearer test-token-123");
  });

  test("no Authorization header when authToken is unset", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    let sawAuth: string | null = "unset";
    const fetchImpl = makeFetchImpl((_url, init) => {
      sawAuth = new Headers(init!.headers as HeadersInit).get("authorization");
      return new Response(JSON.stringify(makeGitHubResponse("v2.0.0")));
    });
    await checkForUpdate(cfg, true, fetchImpl);
    expect(sawAuth as string | null).toBeNull();
  });

  test("writes cache after successful fetch", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fetchImpl = makeFetchImpl(
      () => new Response(JSON.stringify(makeGitHubResponse("v2.0.0"))),
    );
    await checkForUpdate(cfg, true, fetchImpl);
    const cache = readCache(cfg.cacheDir);
    expect(cache).not.toBeNull();
    expect(cache!.latest_version).toBe("2.0.0");
  });

  test("uses /latest for stable channel", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0", channel: "stable" });
    let urlCalled = "";
    const fetchImpl = makeFetchImpl((url) => {
      urlCalled = url;
      return new Response(JSON.stringify(makeGitHubResponse("v2.0.0")));
    });
    await checkForUpdate(cfg, true, fetchImpl);
    expect(urlCalled).toContain("/releases/latest");
  });

  test("uses ?per_page=1 for beta channel", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0", channel: "beta" });
    let urlCalled = "";
    const fetchImpl = makeFetchImpl((url) => {
      urlCalled = url;
      return new Response(JSON.stringify([makeGitHubResponse("v2.0.0-beta.1")]));
    });
    await checkForUpdate(cfg, true, fetchImpl);
    expect(urlCalled).toContain("per_page=1");
  });
});
