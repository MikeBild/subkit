import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  RCODESIGN_SHA256,
  rcodesignArchiveUrl,
  resolveRcodesignTarget,
  verifyArchiveChecksum,
} from "../install-rcodesign.ts";
import { darwinSigner, hasAdHocSignature } from "../stage-cli-binaries.ts";

describe("rcodesign target resolution", () => {
  test("maps supported platforms", () => {
    expect(resolveRcodesignTarget("linux", "x64")).toBe("x86_64-unknown-linux-musl");
    expect(resolveRcodesignTarget("linux", "arm64")).toBe("aarch64-unknown-linux-musl");
    expect(resolveRcodesignTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(resolveRcodesignTarget("darwin", "x64")).toBe("x86_64-apple-darwin");
  });

  test("refuses unsupported platforms", () => {
    expect(() => resolveRcodesignTarget("win32", "x64")).toThrow(/no pinned/);
  });

  test("every supported target has a pinned sha and a release url", () => {
    for (const [platform, arch] of [
      ["linux", "x64"],
      ["linux", "arm64"],
      ["darwin", "arm64"],
      ["darwin", "x64"],
    ] as const) {
      const target = resolveRcodesignTarget(platform, arch);
      expect(RCODESIGN_SHA256[target]).toMatch(/^[0-9a-f]{64}$/);
      expect(rcodesignArchiveUrl(target)).toContain(`-${target}.tar.gz`);
    }
  });

  test("pinned table holds only 64-hex digests", () => {
    for (const sha of Object.values(RCODESIGN_SHA256)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyArchiveChecksum", () => {
  test("refuses a mismatching archive", () => {
    expect(() => verifyArchiveChecksum("aarch64-apple-darwin", new Uint8Array([1, 2, 3]))).toThrow(
      /checksum mismatch/,
    );
  });

  test("refuses an unknown target", () => {
    expect(() => verifyArchiveChecksum("nope", new Uint8Array())).toThrow(/no pinned checksum/);
  });

  test("digest is computed over the bytes", () => {
    const bytes = new Uint8Array([9, 9]);
    const actual = createHash("sha256").update(bytes).digest("hex");
    expect(actual).not.toBe(RCODESIGN_SHA256["aarch64-apple-darwin"]);
  });
});

describe("darwinSigner", () => {
  test("darwin host uses the codesign script", () => {
    expect(darwinSigner("darwin", null)).toBe("codesign-script");
  });

  test("linux host with rcodesign uses it", () => {
    expect(darwinSigner("linux", "/usr/local/bin/rcodesign")).toBe("rcodesign");
  });

  test("linux host without rcodesign throws", () => {
    expect(() => darwinSigner("linux", null)).toThrow(/rcodesign not found/);
  });
});

describe("hasAdHocSignature", () => {
  test("detects ad-hoc flag", () => {
    expect(hasAdHocSignature("flags: CodeSignatureFlags(ADHOC)")).toBe(true);
    expect(hasAdHocSignature("flags: none")).toBe(false);
  });
});
