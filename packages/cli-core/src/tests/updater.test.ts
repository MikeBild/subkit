import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkForUpdate,
  defaultUpdaterConfig,
  engineRelease,
  latestRelease,
  parseChecksum,
  readCache,
  type UpdateCache,
  writeCache,
} from "../updater.ts";
import {
  makeCacheDir,
  makeConfig,
  makeFetchImpl,
  TEST_NOW_MS,
  useUpdaterTmpDir,
} from "./updater-fixtures.ts";

useUpdaterTmpDir();

function releaseRedirect(tag: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `https://github.test/o/r/releases/tag/${tag}` },
  });
}

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
    const sums = `${hash64}  subkit-darwin-arm64\n`;
    expect(parseChecksum(sums, "subkit-darwin-arm64")).toBe(hash64);
  });

  test("returns null when asset not found", () => {
    const sums = `${hash64}  subkit-darwin-arm64\n`;
    expect(parseChecksum(sums, "subkit-linux-x64")).toBeNull();
  });

  test("handles multiple entries", () => {
    const sums = `${hash64}  subkit-darwin-arm64\n${hash64b}  subkit-linux-x64\n`;
    expect(parseChecksum(sums, "subkit-linux-x64")).toBe(hash64b);
    expect(parseChecksum(sums, "subkit-darwin-arm64")).toBe(hash64);
  });

  test("handles empty file", () => {
    expect(parseChecksum("", "subkit-darwin-arm64")).toBeNull();
  });

  test("handles extra whitespace and blank lines", () => {
    const sums = `\n  \n${hash64}  subkit-darwin-arm64\n\n`;
    expect(parseChecksum(sums, "subkit-darwin-arm64")).toBe(hash64);
  });
});

describe("defaultUpdaterConfig", () => {
  test("selects the release asset of the running platform", () => {
    const cfg = defaultUpdaterConfig("subkit", "1.0.0");
    expect(cfg.binaryName).toBe("subkit");
    expect(cfg.asset === null || cfg.asset.startsWith("subkit-")).toBe(true);
    expect(cfg.releasesUrl).toBe(
      process.env.SUBKIT_RELEASES_URL || "https://github.com/MikeBild/subkit/releases",
    );
  });

  test("checks once a day and keeps its cache per binary", () => {
    const cfg = defaultUpdaterConfig("my-tool", "1.0.0");
    expect(cfg.checkIntervalMs).toBe(86_400_000);
    expect(cfg.cacheDir).toContain("my-tool");
    expect(cfg.asset).toBeNull();
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
      return releaseRedirect("v2.0.0");
    });
    await checkForUpdate(cfg, true, fetchImpl);
    expect(fetchCalled).toBe(true);
  });

  test("returns null when remote version equals local", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fetchImpl = makeFetchImpl(() => releaseRedirect("v1.0.0"));
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

  test("explicit check (force=true) THROWS when no release is published", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fetchImpl = makeFetchImpl(() => new Response("not found", { status: 404 }));
    await expect(checkForUpdate(cfg, true, fetchImpl)).rejects.toThrow(/no published release/);
  });

  test("writes cache after successful fetch", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fetchImpl = makeFetchImpl(() => releaseRedirect("v2.0.0"));
    await checkForUpdate(cfg, true, fetchImpl);
    const cache = readCache(cfg.cacheDir);
    expect(cache).not.toBeNull();
    expect(cache!.latest_version).toBe("2.0.0");
  });

  test("asks the latest-release redirect and downloads from the pinned tag", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    let urlCalled = "";
    const fetchImpl = makeFetchImpl((url, init) => {
      urlCalled = url;
      expect(init?.redirect).toBe("manual");
      return releaseRedirect("v2.0.0");
    });
    const info = await checkForUpdate(cfg, true, fetchImpl);
    expect(urlCalled).toBe("https://github.test/o/r/releases/latest");
    expect(info?.assets.map((a) => a.url)).toEqual([
      "https://github.test/o/r/releases/download/v2.0.0/test-bin-linux-x64",
      "https://github.test/o/r/releases/download/v2.0.0/SHA256SUMS",
      "https://github.test/o/r/releases/download/v2.0.0/SHA256SUMS.sig",
      "https://github.test/o/r/releases/download/v2.0.0/LICENSE",
      "https://github.test/o/r/releases/download/v2.0.0/THIRD_PARTY_NOTICES.txt",
    ]);
  });
});

describe("latestRelease", () => {
  test("returns the latest release even when it is not newer", async () => {
    const info = await latestRelease(
      makeConfig({ currentVersion: "3.0.0" }),
      makeFetchImpl(() => releaseRedirect("v2.0.0")),
    );
    expect(info.version).toBe("2.0.0");
  });
});

describe("engineRelease", () => {
  const engine = "https://engine.example.test/";

  test("a signed bundle on the engine is the source of the engine's version", async () => {
    const seen: string[] = [];
    const fetchImpl = makeFetchImpl((url) => {
      seen.push(url);
      if (url === "https://engine.example.test/health") return Response.json({ version: "2.0.0" });
      if (url === "https://engine.example.test/install/SHA256SUMS.sig") return new Response("");
      return new Response("unexpected", { status: 500 });
    });
    const info = await engineRelease(makeConfig(), engine, fetchImpl);
    expect(info.version).toBe("2.0.0");
    expect(info.assets[0]).toEqual({
      name: "test-bin-linux-x64",
      url: "https://engine.example.test/install/test-bin-linux-x64",
    });
    expect(seen.some((url) => url.includes("github"))).toBe(false);
  });

  test("an engine without the bundle points at the release with its version", async () => {
    const fetchImpl = makeFetchImpl((url) =>
      url.endsWith("/health")
        ? Response.json({ version: "2.0.0" })
        : new Response("absent", { status: 404 }),
    );
    const info = await engineRelease(makeConfig(), engine, fetchImpl);
    expect(info.assets[0]?.url).toBe(
      "https://github.test/o/r/releases/download/v2.0.0/test-bin-linux-x64",
    );
  });

  test("an engine without a release version cannot be matched", async () => {
    const fetchImpl = makeFetchImpl(() => Response.json({ version: "unknown" }));
    await expect(engineRelease(makeConfig(), engine, fetchImpl)).rejects.toThrow(
      "did not report a release version",
    );
  });
});
