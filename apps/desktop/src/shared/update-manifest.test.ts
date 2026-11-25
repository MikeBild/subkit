import { describe, expect, test } from "bun:test";
import { checksumUrls, judgeDownload, parseChecksums } from "./update-manifest.ts";

const hash = "a".repeat(64);
const manifest = `${hash}  subkit-desktop-13.1.0-win-x64.exe\n${"b".repeat(64)} *latest.yml\n`;

describe("parseChecksums", () => {
  test("reads sha256sum lines with and without the binary marker", () => {
    const entries = parseChecksums(manifest);
    expect(entries.get("subkit-desktop-13.1.0-win-x64.exe")).toBe(hash);
    expect(entries.get("latest.yml")).toBe("b".repeat(64));
  });

  test("ignores lines that are not checksums", () => {
    expect(parseChecksums("garbage\n\n").size).toBe(0);
  });
});

describe("judgeDownload", () => {
  const base = {
    manifest,
    fileName: "subkit-desktop-13.1.0-win-x64.exe",
    sha256: hash.toUpperCase(),
  };

  test("accepts a listed file with the signed checksum", () => {
    expect(judgeDownload({ ...base, signatureValid: true })).toEqual({ ok: true });
  });

  test("refuses when the manifest signature does not verify", () => {
    expect(judgeDownload({ ...base, signatureValid: false })).toEqual({
      ok: false,
      reason: "signature_invalid",
    });
  });

  test("refuses a file the manifest does not list", () => {
    expect(judgeDownload({ ...base, signatureValid: true, fileName: "other.exe" })).toEqual({
      ok: false,
      reason: "not_listed",
    });
  });

  test("refuses a file whose checksum differs", () => {
    expect(judgeDownload({ ...base, signatureValid: true, sha256: "c".repeat(64) })).toEqual({
      ok: false,
      reason: "checksum_mismatch",
    });
  });
});

test("checksumUrls points at the release of the version", () => {
  expect(checksumUrls("MikeBild/subkit", "13.1.0")).toEqual({
    manifest: "https://github.com/MikeBild/subkit/releases/download/v13.1.0/SHA256SUMS-desktop",
    signature:
      "https://github.com/MikeBild/subkit/releases/download/v13.1.0/SHA256SUMS-desktop.sig",
  });
});
