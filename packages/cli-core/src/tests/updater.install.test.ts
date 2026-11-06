import { describe, expect, test } from "bun:test";
import { createHash, sign as cryptoSign } from "node:crypto";
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
import {
  checkForUpdate,
  listRetainedVersions,
  performUpdate,
  platformArch,
  prepareDownloadedBinary,
  pruneRetainedVersions,
  rollbackTo,
  type UpdateInfo,
  type UpdaterConfig,
  verifySignature,
} from "../updater.ts";
import {
  makeCacheDir,
  makeConfig,
  makeFetchImpl,
  makeGitHubResponse,
  TEST_NOW_MS,
  TEST_PRIVATE_KEY,
  TEST_PUBLIC_KEY_PEM,
  useUpdaterTmpDir,
} from "./updater-fixtures.ts";

function signSums(sumsText: string): Buffer {
  return cryptoSign(null, Buffer.from(sumsText, "utf8"), TEST_PRIVATE_KEY);
}

useUpdaterTmpDir();

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
