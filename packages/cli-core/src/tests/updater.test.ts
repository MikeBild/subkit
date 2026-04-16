import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type UpdateCache,
  type UpdateInfo,
  type UpdaterConfig,
  checkForUpdate,
  defaultUpdaterConfig,
  formatUpdateBanner,
  isNewer,
  parseChecksum,
  platformArch,
  readCache,
  writeCache,
} from "../updater.ts";

// ── Helpers ──

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "updater-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeCacheDir(): string {
  const dir = mkdtempSync(join(tmpDir, "cache-"));
  return dir;
}

function makeGitHubResponse(tag: string, assets: Array<{ name: string }> = []) {
  return {
    tag_name: tag,
    prerelease: false,
    body: "release notes",
    assets: assets.map((a) => ({
      name: a.name,
      browser_download_url: `https://github.com/test/repo/releases/download/${tag}/${a.name}`,
    })),
  };
}

function makeFetchImpl(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as typeof fetch;
}

function makeConfig(overrides: Partial<UpdaterConfig> = {}): UpdaterConfig {
  return {
    binaryName: "test-bin",
    currentVersion: "1.0.0",
    cacheDir: makeCacheDir(),
    githubRepo: "test/repo",
    checkIntervalMs: 86_400_000,
    channel: "stable",
    ...overrides,
  };
}

// ── isNewer ──

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
    // "1.2" parsed as [1, 2, NaN] → NaN ?? 0 → [1, 2, 0]
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

// ── platformArch ──

describe("platformArch", () => {
  test("returns os/arch/ext for current platform", () => {
    const result = platformArch();
    // This test runs on a real platform so result should not be null
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
    if (!result) return; // skip on unsupported platform
    const expected: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
    expect(result.os).toBe(expected[process.platform]!);
  });
});

// ── parseChecksum ──

describe("parseChecksum", () => {
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

  test("handles two-space separator format", () => {
    const sums = `${hash64}  sk_darwin_arm64`;
    expect(parseChecksum(sums, "sk_darwin_arm64")).toBe(hash64);
  });

  test("handles single-space separator", () => {
    const sums = `${hash64} sk_darwin_arm64`;
    expect(parseChecksum(sums, "sk_darwin_arm64")).toBe(hash64);
  });
});

// ── formatUpdateBanner ──

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

// ── defaultUpdaterConfig ──

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

// ── Cache management ──

describe("cache management", () => {
  test("writeCache creates directory recursively", () => {
    const dir = join(makeCacheDir(), "deep", "nested");
    const cache: UpdateCache = {
      last_check: Date.now(),
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

// ── checkForUpdate ──

describe("checkForUpdate", () => {
  test("returns null when cache is fresh and version is current", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    // Pre-seed cache with same version, recent timestamp
    writeCache(cfg.cacheDir, {
      last_check: Date.now(),
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
      last_check: Date.now(),
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

  test("fetches from GitHub when cache is stale", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    // Seed an old cache
    writeCache(cfg.cacheDir, {
      last_check: Date.now() - 100_000_000, // way past 24h
      latest_version: "1.0.0",
      latest_tag: "v1.0.0",
      current_version_at_check: "1.0.0",
    });
    let fetchCalled = false;
    const fetchImpl = makeFetchImpl(() => {
      fetchCalled = true;
      return new Response(JSON.stringify(makeGitHubResponse("v2.0.0")));
    });
    const result = await checkForUpdate(cfg, false, fetchImpl);
    expect(fetchCalled).toBe(true);
    expect(result).not.toBeNull();
    expect(result!.version).toBe("2.0.0");
  });

  test("force=true bypasses cache", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    // Seed a fresh cache
    writeCache(cfg.cacheDir, {
      last_check: Date.now(),
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
    const fetchImpl = makeFetchImpl(() =>
      new Response(JSON.stringify(makeGitHubResponse("v1.0.0"))),
    );
    const result = await checkForUpdate(cfg, true, fetchImpl);
    expect(result).toBeNull();
  });

  test("returns null on network failure", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fetchImpl = makeFetchImpl(() => {
      throw new Error("network error");
    });
    const result = await checkForUpdate(cfg, true, fetchImpl);
    expect(result).toBeNull();
  });

  test("returns null on non-200 response", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fetchImpl = makeFetchImpl(() => new Response("not found", { status: 404 }));
    const result = await checkForUpdate(cfg, true, fetchImpl);
    expect(result).toBeNull();
  });

  test("writes cache after successful fetch", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fetchImpl = makeFetchImpl(() =>
      new Response(JSON.stringify(makeGitHubResponse("v2.0.0"))),
    );
    await checkForUpdate(cfg, true, fetchImpl);
    const cache = readCache(cfg.cacheDir);
    expect(cache).not.toBeNull();
    expect(cache!.latest_version).toBe("2.0.0");
  });

  test("strips v prefix from tag_name", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fetchImpl = makeFetchImpl(() =>
      new Response(JSON.stringify(makeGitHubResponse("v2.5.1"))),
    );
    const result = await checkForUpdate(cfg, true, fetchImpl);
    expect(result!.version).toBe("2.5.1");
    expect(result!.tag).toBe("v2.5.1");
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

// ── performUpdate ──

describe("performUpdate", () => {
  test("throws when binary asset missing from release", async () => {
    const cfg = makeConfig();
    const info: UpdateInfo = {
      version: "2.0.0",
      tag: "v2.0.0",
      assets: [{ name: "SHA256SUMS", url: "https://example.com/SHA256SUMS" }],
      body: "",
    };
    const fetchImpl = makeFetchImpl(() => new Response(""));
    await expect(import("../updater.ts").then((m) => m.performUpdate(cfg, info, fetchImpl))).rejects.toThrow(
      /no binary/,
    );
  });

  test("throws when SHA256SUMS asset missing", async () => {
    const pa = platformArch()!;
    const cfg = makeConfig();
    const assetName = `${cfg.binaryName}_${pa.os}_${pa.arch}${pa.ext}`;
    const info: UpdateInfo = {
      version: "2.0.0",
      tag: "v2.0.0",
      assets: [{ name: assetName, url: "https://example.com/binary" }],
      body: "",
    };
    const fetchImpl = makeFetchImpl(() => new Response(""));
    await expect(import("../updater.ts").then((m) => m.performUpdate(cfg, info, fetchImpl))).rejects.toThrow(
      /SHA256SUMS/,
    );
  });

  test("throws on checksum mismatch", async () => {
    const pa = platformArch()!;
    const cfg = makeConfig();
    const assetName = `${cfg.binaryName}_${pa.os}_${pa.arch}${pa.ext}`;
    const wrongHash = "f".repeat(64);
    const info: UpdateInfo = {
      version: "2.0.0",
      tag: "v2.0.0",
      assets: [
        { name: assetName, url: "https://example.com/binary" },
        { name: "SHA256SUMS", url: "https://example.com/SHA256SUMS" },
      ],
      body: "",
    };
    const fetchImpl = makeFetchImpl((url) => {
      if (url.includes("SHA256SUMS")) {
        return new Response(`${wrongHash}  ${assetName}\n`);
      }
      return new Response("binary-content");
    });
    await expect(import("../updater.ts").then((m) => m.performUpdate(cfg, info, fetchImpl))).rejects.toThrow(
      /checksum mismatch/,
    );
  });

  test("cleans up temp file on error", async () => {
    const pa = platformArch()!;
    const cfg = makeConfig();
    const assetName = `${cfg.binaryName}_${pa.os}_${pa.arch}${pa.ext}`;
    const info: UpdateInfo = {
      version: "2.0.0",
      tag: "v2.0.0",
      assets: [
        { name: assetName, url: "https://example.com/binary" },
        { name: "SHA256SUMS", url: "https://example.com/SHA256SUMS" },
      ],
      body: "",
    };
    const fetchImpl = makeFetchImpl((url) => {
      if (url.includes("SHA256SUMS")) {
        return new Response(`${"f".repeat(64)}  ${assetName}\n`);
      }
      return new Response("binary-content");
    });
    try {
      await import("../updater.ts").then((m) => m.performUpdate(cfg, info, fetchImpl));
    } catch {
      // expected
    }
    // Verify temp file was cleaned up
    const tmpPath = join(cfg.cacheDir, "tmp", `${cfg.binaryName}.download.${process.pid}`);
    expect(existsSync(tmpPath)).toBe(false);
  });

  test("throws on SHA256SUMS fetch failure", async () => {
    const pa = platformArch()!;
    const cfg = makeConfig();
    const assetName = `${cfg.binaryName}_${pa.os}_${pa.arch}${pa.ext}`;
    const info: UpdateInfo = {
      version: "2.0.0",
      tag: "v2.0.0",
      assets: [
        { name: assetName, url: "https://example.com/binary" },
        { name: "SHA256SUMS", url: "https://example.com/SHA256SUMS" },
      ],
      body: "",
    };
    const fetchImpl = makeFetchImpl((url) => {
      if (url.includes("SHA256SUMS")) {
        return new Response("not found", { status: 404 });
      }
      return new Response("binary-content");
    });
    await expect(import("../updater.ts").then((m) => m.performUpdate(cfg, info, fetchImpl))).rejects.toThrow(
      /failed to download SHA256SUMS/,
    );
  });
});
