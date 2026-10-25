import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTestNow } from "../../../../apps/engine/src/test-helpers/determinism/clock.ts";
import {
  checkForUpdate,
  defaultUpdaterConfig,
  formatUpdateBanner,
  isNewer,
  listRetainedVersions,
  parseChecksum,
  performUpdate,
  platformArch,
  prepareDownloadedBinary,
  pruneRetainedVersions,
  readCache,
  rollbackTo,
  type UpdateCache,
  type UpdateInfo,
  type UpdaterConfig,
  verifySignature,
  writeCache,
} from "../updater.ts";

const TEST_NOW_MS = getTestNow();

const { publicKey: TEST_PUBLIC_KEY, privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("ed25519");
const TEST_PUBLIC_KEY_PEM = TEST_PUBLIC_KEY.export({ format: "pem", type: "spki" }).toString();

function signSums(sumsText: string): Buffer {
  return cryptoSign(null, Buffer.from(sumsText, "utf8"), TEST_PRIVATE_KEY);
}

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

function makeFetchImpl(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
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
    publicKey: TEST_PUBLIC_KEY_PEM,
    ...overrides,
  };
}

function buildSignedRelease(opts: { binaryName: string; binaryBytes: Buffer; tag: string }): {
  info: UpdateInfo;
  fetchImpl: typeof fetch;
  sumsText: string;
  expectedHash: string;
} {
  const pa = platformArch()!;
  const assetName = `${opts.binaryName}_${pa.os}_${pa.arch}${pa.ext}`;
  const expectedHash = createHash("sha256").update(opts.binaryBytes).digest("hex");
  const noticeFiles = { LICENSE: "Fixture license", "THIRD_PARTY_NOTICES.txt": "Fixture notices" };
  const sumsText =
    `${expectedHash}  ${assetName}\n` +
    Object.entries(noticeFiles)
      .map(([name, text]) => `${createHash("sha256").update(text).digest("hex")}  ${name}\n`)
      .join("");
  const sig = signSums(sumsText);
  const info: UpdateInfo = {
    version: opts.tag.replace(/^v/, ""),
    tag: opts.tag,
    assets: [
      ...Object.keys(noticeFiles).map((name) => ({
        name,
        url: `https://example.com/${opts.tag}/${name}`,
      })),
      { name: assetName, url: `https://example.com/${opts.tag}/${assetName}` },
      { name: "SHA256SUMS", url: `https://example.com/${opts.tag}/SHA256SUMS` },
      { name: "SHA256SUMS.sig", url: `https://example.com/${opts.tag}/SHA256SUMS.sig` },
    ],
    body: "",
  };
  const fetchImpl = makeFetchImpl((url) => {
    for (const [name, text] of Object.entries(noticeFiles))
      if (url.endsWith(`/${name}`)) return new Response(text);
    if (url.endsWith("/SHA256SUMS.sig")) {
      return new Response(new Uint8Array(sig));
    }
    if (url.endsWith("/SHA256SUMS")) {
      return new Response(sumsText);
    }
    if (url.endsWith(`/${assetName}`)) {
      return new Response(new Uint8Array(opts.binaryBytes));
    }
    return new Response("not-found", { status: 404 });
  });
  return { info, fetchImpl, sumsText, expectedHash };
}

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

describe("verifySignature", () => {
  test("accepts a valid Ed25519 signature", () => {
    const message = "the quick brown fox";
    const sig = signSums(message);
    expect(verifySignature(message, sig, TEST_PUBLIC_KEY_PEM)).toBe(true);
  });

  test("rejects a signature when the message has been tampered with", () => {
    const original = "release sums file";
    const sig = signSums(original);
    expect(verifySignature(`${original} tampered`, sig, TEST_PUBLIC_KEY_PEM)).toBe(false);
  });

  test("rejects when the signature itself is bogus", () => {
    const message = "release sums file";
    const bogusSig = Buffer.alloc(64);
    expect(verifySignature(message, bogusSig, TEST_PUBLIC_KEY_PEM)).toBe(false);
  });

  test("returns false (rather than throwing) on a malformed public key", () => {
    const message = "release sums file";
    const sig = signSums(message);
    expect(verifySignature(message, sig, "not a real PEM")).toBe(false);
  });
});

describe("performUpdate signature gating", () => {
  test("rejects a correctly signed duplicate manifest before downloading the binary", async () => {
    const cfg = makeConfig();
    const release = buildSignedRelease({
      binaryName: cfg.binaryName,
      binaryBytes: Buffer.from("candidate"),
      tag: "v2.0.0",
    });
    const sums = release.sumsText + release.sumsText;
    let binaryRequested = false;
    const fetchImpl = makeFetchImpl((url) => {
      if (url.endsWith("/SHA256SUMS")) return new Response(sums);
      if (url.endsWith("/SHA256SUMS.sig")) return new Response(new Uint8Array(signSums(sums)));
      binaryRequested = true;
      return new Response("candidate");
    });
    await expect(performUpdate(cfg, release.info, fetchImpl)).rejects.toThrow("no checksum");
    expect(binaryRequested).toBe(false);
    expect(listRetainedVersions(cfg)).toEqual([]);
  });

  test("throws when SHA256SUMS.sig asset is missing", async () => {
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
    const fetchImpl = makeFetchImpl(() => new Response(""));
    await expect(performUpdate(cfg, info, fetchImpl)).rejects.toThrow(/SHA256SUMS\.sig/);
  });

  test("throws when SHA256SUMS body has been tampered with (signature mismatch)", async () => {
    const cfg = makeConfig();
    const release = buildSignedRelease({
      binaryName: cfg.binaryName,
      binaryBytes: Buffer.from("hello"),
      tag: "v2.0.0",
    });
    const tamperedFetch = makeFetchImpl((url) => {
      if (url.endsWith("/SHA256SUMS")) {
        return new Response(`${"f".repeat(64)}  not_what_we_signed\n`);
      }
      return release.fetchImpl(url);
    });
    await expect(performUpdate(cfg, release.info, tamperedFetch)).rejects.toThrow(
      /signature verification failed/,
    );
  });

  test("throws when the .sig payload is corrupted", async () => {
    const cfg = makeConfig();
    const release = buildSignedRelease({
      binaryName: cfg.binaryName,
      binaryBytes: Buffer.from("hello"),
      tag: "v2.0.0",
    });
    const tamperedFetch = makeFetchImpl((url) => {
      if (url.endsWith("/SHA256SUMS.sig")) return new Response(new Uint8Array(64));
      return release.fetchImpl(url);
    });
    await expect(performUpdate(cfg, release.info, tamperedFetch)).rejects.toThrow(
      /signature verification failed/,
    );
  });
});

describe("performUpdate retention", () => {
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"]) {
    for (const mode of ["missing", "duplicate", "empty"]) {
      test(`rejects ${mode} ${name} before binary retention`, async () => {
        const cfg = makeConfig();
        const release = buildSignedRelease({
          binaryName: cfg.binaryName,
          binaryBytes: Buffer.from("NEW"),
          tag: "v2.0.0",
        });
        if (mode === "missing")
          release.info.assets = release.info.assets.filter((asset) => asset.name !== name);
        if (mode === "duplicate")
          release.info.assets.push(release.info.assets.find((asset) => asset.name === name)!);
        const fetchImpl = makeFetchImpl((url) =>
          mode === "empty" && url.endsWith(`/${name}`) ? new Response("") : release.fetchImpl(url),
        );
        await expect(performUpdate(cfg, release.info, fetchImpl)).rejects.toThrow(/notice/i);
        expect(listRetainedVersions(cfg)).toEqual([]);
      });
    }
  }

  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"]) {
    test(`rejects tampered ${name} before retaining or replacing any binary`, async () => {
      const cfg = makeConfig();
      const release = buildSignedRelease({
        binaryName: cfg.binaryName,
        binaryBytes: Buffer.from("NEW"),
        tag: "v2.0.0",
      });
      const fetchImpl = makeFetchImpl((url) =>
        url.endsWith(`/${name}`) ? new Response("tampered") : release.fetchImpl(url),
      );
      await expect(performUpdate(cfg, release.info, fetchImpl)).rejects.toThrow(
        "Notice checksum mismatch",
      );
      expect(listRetainedVersions(cfg)).toEqual([]);
    });
  }

  test("happy path returns from/to/sha256 and retains the prior binary", async () => {
    const cfg = makeConfig();
    const fakeBinary = join(makeCacheDir(), "test-bin");
    writeFileSync(fakeBinary, Buffer.from("OLD-BINARY"));
    writeFileSync(join(fakeBinary, "..", "subkit.LICENSE"), "OLD-LICENSE");
    writeFileSync(join(fakeBinary, "..", "subkit.THIRD_PARTY_NOTICES.txt"), "OLD-NOTICES");
    const realExecPath = process.execPath;
    Object.defineProperty(process, "execPath", { value: fakeBinary, configurable: true });
    try {
      const release = buildSignedRelease({
        binaryName: cfg.binaryName,
        binaryBytes: Buffer.from("NEW-BINARY"),
        tag: "v2.0.0",
      });
      const result = await performUpdate(cfg, release.info, release.fetchImpl);
      expect(result.from_version).toBe("1.0.0");
      expect(result.to_version).toBe("2.0.0");
      expect(result.sha256).toHaveLength(64);
      expect(readFileSync(fakeBinary).toString()).toBe("NEW-BINARY");
      const retained = listRetainedVersions(cfg);
      expect(retained.length).toBe(1);
      expect(retained[0]!.version).toBe("1.0.0");
      expect(readFileSync(retained[0]!.path).toString()).toBe("OLD-BINARY");
      expect(readFileSync(join(fakeBinary, "..", "subkit.LICENSE"), "utf8")).toBe(
        "Fixture license",
      );
      expect(readFileSync(join(fakeBinary, "..", "subkit.THIRD_PARTY_NOTICES.txt"), "utf8")).toBe(
        "Fixture notices",
      );
      rollbackTo({ ...cfg, currentVersion: "2.0.0" }, "1.0.0");
      expect(readFileSync(fakeBinary, "utf8")).toBe("OLD-BINARY");
      expect(readFileSync(join(fakeBinary, "..", "subkit.LICENSE"), "utf8")).toBe("OLD-LICENSE");
      expect(readFileSync(join(fakeBinary, "..", "subkit.THIRD_PARTY_NOTICES.txt"), "utf8")).toBe(
        "OLD-NOTICES",
      );
    } finally {
      Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true });
    }
  });

  test("updates from a running binary that is not listed in any signed SHA256SUMS", async () => {
    const cfg = makeConfig({ currentVersion: "1.0.0" });
    const fakeBinary = join(makeCacheDir(), "test-bin");
    writeFileSync(fakeBinary, Buffer.from("MANUALLY-RE-SIGNED-OLD-BINARY"));
    const realExecPath = process.execPath;
    Object.defineProperty(process, "execPath", { value: fakeBinary, configurable: true });
    try {
      const release = buildSignedRelease({
        binaryName: cfg.binaryName,
        binaryBytes: Buffer.from("RELEASE-BINARY"),
        tag: "v2.0.0",
      });
      expect(release.sumsText).not.toContain(
        createHash("sha256").update("MANUALLY-RE-SIGNED-OLD-BINARY").digest("hex"),
      );
      const result = await performUpdate(cfg, release.info, release.fetchImpl);
      expect(result.sha256).toBe(release.expectedHash);
      expect(readFileSync(fakeBinary, "utf8")).toBe("RELEASE-BINARY");
      rollbackTo({ ...cfg, currentVersion: "2.0.0" }, "1.0.0");
      expect(readFileSync(fakeBinary, "utf8")).toBe("MANUALLY-RE-SIGNED-OLD-BINARY");
    } finally {
      Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true });
    }
  });
});

describe("retained versions store", () => {
  test("pruneRetainedVersions keeps the N most recent by installed_at", () => {
    const cfg = makeConfig();
    for (const [version, atOffset] of [
      ["1.0.0", 0],
      ["1.1.0", 1000],
      ["1.2.0", 2000],
      ["1.3.0", 3000],
    ] as const) {
      const dir = join(cfg.cacheDir, "versions", version);
      mkdirSync(dir, { recursive: true });
      const binPath = join(dir, cfg.binaryName);
      writeFileSync(binPath, version);
      const sha = createHash("sha256").update(version).digest("hex");
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
          version,
          installed_at: TEST_NOW_MS + atOffset,
          sha256: sha,
          binary_name: cfg.binaryName,
        }),
      );
    }
    pruneRetainedVersions(cfg, 2);
    const after = listRetainedVersions(cfg);
    expect(after.map((v) => v.version)).toEqual(["1.3.0", "1.2.0"]);
  });
});

describe("rollbackTo", () => {
  function plantRetained(
    cfg: UpdaterConfig,
    version: string,
    bytes: Buffer,
    installed_at: number,
  ): string {
    const dir = join(cfg.cacheDir, "versions", version);
    mkdirSync(dir, { recursive: true });
    const binPath = join(dir, cfg.binaryName);
    writeFileSync(binPath, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ version, installed_at, sha256: sha, binary_name: cfg.binaryName }),
    );
    return binPath;
  }

  test("restores the most recent retained binary when target is 'previous'", () => {
    const cfg = makeConfig({ currentVersion: "2.0.0" });
    const fakeBinary = join(makeCacheDir(), "test-bin");
    writeFileSync(fakeBinary, Buffer.from("CURRENT-2.0.0"));
    plantRetained(cfg, "1.9.0", Buffer.from("OLDEST"), TEST_NOW_MS - 2000);
    plantRetained(cfg, "1.10.0", Buffer.from("MIDDLE"), TEST_NOW_MS - 1000);
    plantRetained(cfg, "1.11.0", Buffer.from("MOST-RECENT"), TEST_NOW_MS - 500);

    const realExecPath = process.execPath;
    Object.defineProperty(process, "execPath", { value: fakeBinary, configurable: true });
    try {
      const result = rollbackTo(cfg, "previous");
      expect(result.to_version).toBe("1.11.0");
      expect(readFileSync(fakeBinary).toString()).toBe("MOST-RECENT");
      const retained = listRetainedVersions(cfg);
      expect(retained.map((v) => v.version)).toContain("2.0.0");
    } finally {
      Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true });
    }
  });

  test("throws when the retained binary's hash drifts from the manifest", () => {
    const cfg = makeConfig({ currentVersion: "2.0.0" });
    const fakeBinary = join(makeCacheDir(), "test-bin");
    writeFileSync(fakeBinary, Buffer.from("CURRENT"));
    const planted = plantRetained(cfg, "1.9.0", Buffer.from("ORIGINAL"), TEST_NOW_MS - 1000);
    writeFileSync(planted, Buffer.from("TAMPERED"));

    const realExecPath = process.execPath;
    Object.defineProperty(process, "execPath", { value: fakeBinary, configurable: true });
    try {
      expect(() => rollbackTo(cfg, "previous")).toThrow(/integrity check/);
    } finally {
      Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true });
    }
  });

  test("throws when no retained binaries exist", () => {
    const cfg = makeConfig({ currentVersion: "2.0.0" });
    expect(() => rollbackTo(cfg, "previous")).toThrow(/no retained binaries/);
  });
});

describe("prepareDownloadedBinary", () => {
  test("keeps the verified bytes so the installed binary still matches SHA256SUMS", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-prepare-"));
    try {
      const path = join(dir, "sk");
      copyFileSync(existsSync("/usr/bin/true") ? "/usr/bin/true" : process.execPath, path);
      const before = createHash("sha256").update(readFileSync(path)).digest("hex");
      prepareDownloadedBinary(path, process.platform);
      const after = createHash("sha256").update(readFileSync(path)).digest("hex");
      expect(after).toBe(before);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine update source", () => {
  const engine = "https://engine.example.test/";
  const pa = platformArch()!;

  test("a signed bundle on the configured engine is the stable update, without GitHub", async () => {
    const seen: string[] = [];
    const fetchImpl = makeFetchImpl((url) => {
      seen.push(url);
      if (url === "https://engine.example.test/health")
        return Response.json({ status: "ok", version: "2.0.0" });
      if (url === "https://engine.example.test/install/sha256sums.sig")
        return new Response(new Uint8Array(64));
      return new Response("unexpected", { status: 500 });
    });
    const info = await checkForUpdate(makeConfig({ engineUrl: engine }), true, fetchImpl);
    expect(info?.version).toBe("2.0.0");
    expect(info?.assets).toContainEqual({
      name: `test-bin_${pa.os}_${pa.arch}${pa.ext}`,
      url: `https://engine.example.test/install/test-bin-${pa.os}-${pa.arch}`,
    });
    expect(info?.assets.map((asset) => asset.name)).toEqual(
      expect.arrayContaining([
        "SHA256SUMS",
        "SHA256SUMS.sig",
        "LICENSE",
        "THIRD_PARTY_NOTICES.txt",
      ]),
    );
    expect(seen.some((url) => url.includes("api.github.com"))).toBe(false);
  });

  test("an engine without the release signature falls back to GitHub", async () => {
    const fetchImpl = makeFetchImpl((url) => {
      if (url.endsWith("/health")) return Response.json({ version: "2.0.0" });
      if (url.endsWith("/install/sha256sums.sig")) return new Response("absent", { status: 404 });
      if (url.includes("api.github.com")) return Response.json(makeGitHubResponse("v3.0.0"));
      return new Response("unexpected", { status: 500 });
    });
    const info = await checkForUpdate(makeConfig({ engineUrl: engine }), true, fetchImpl);
    expect(info?.version).toBe("3.0.0");
  });

  test("an engine-served binary still needs the release signature", async () => {
    const release = buildSignedRelease({
      binaryName: "test-bin",
      binaryBytes: Buffer.from("engine-binary"),
      tag: "v2.0.0",
    });
    const forged = makeFetchImpl((url) =>
      url.endsWith("/SHA256SUMS.sig") ? new Response(new Uint8Array(64)) : release.fetchImpl(url),
    );
    await expect(performUpdate(makeConfig(), release.info, forged)).rejects.toThrow(
      "signature verification failed",
    );
  });
});
