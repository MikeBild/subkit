import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  expectedArchFromName,
  inspectMacosBinary,
  MACHO_CPU_TYPES,
  type MacosArch,
} from "../verify-macos-binaries.ts";

const PAGE_SHIFT = 12;

function machO(
  options: { arch?: MacosArch; adHoc?: boolean; signed?: boolean; codeBytes?: number } = {},
): Buffer {
  const arch = options.arch ?? "arm64";
  const signed = options.signed ?? true;
  const codeLength = options.codeBytes ?? 2 * 4096 + 100;
  const commands = signed ? 16 : 0;
  const code = Buffer.alloc(codeLength);
  for (let i = 0; i < codeLength; i++) code[i] = (i * 31) & 0xff;
  code.writeUInt32LE(0xfeedfacf, 0);
  code.writeUInt32LE(MACHO_CPU_TYPES[arch], 4);
  code.writeUInt32LE(0, 8);
  code.writeUInt32LE(2, 12);
  code.writeUInt32LE(signed ? 1 : 0, 16);
  code.writeUInt32LE(commands, 20);
  code.writeUInt32LE(0, 24);
  code.writeUInt32LE(0, 28);
  if (!signed) return code;

  const pageSize = 2 ** PAGE_SHIFT;
  const slots = Math.ceil(codeLength / pageSize);
  const cdLength = 44 + slots * 32;
  const blobLength = 20 + cdLength;
  code.writeUInt32LE(0x1d, 32);
  code.writeUInt32LE(16, 36);
  code.writeUInt32LE(codeLength, 40);
  code.writeUInt32LE(blobLength, 44);

  const blob = Buffer.alloc(blobLength);
  blob.writeUInt32BE(0xfade0cc0, 0);
  blob.writeUInt32BE(blobLength, 4);
  blob.writeUInt32BE(1, 8);
  blob.writeUInt32BE(0, 12);
  blob.writeUInt32BE(20, 16);
  const cd = 20;
  blob.writeUInt32BE(0xfade0c02, cd);
  blob.writeUInt32BE(cdLength, cd + 4);
  blob.writeUInt32BE(0x20100, cd + 8);
  blob.writeUInt32BE((options.adHoc ?? true) ? 0x2 : 0, cd + 12);
  blob.writeUInt32BE(44, cd + 16);
  blob.writeUInt32BE(0, cd + 20);
  blob.writeUInt32BE(0, cd + 24);
  blob.writeUInt32BE(slots, cd + 28);
  blob.writeUInt32BE(codeLength, cd + 32);
  blob.writeUInt8(32, cd + 36);
  blob.writeUInt8(2, cd + 37);
  blob.writeUInt8(0, cd + 38);
  blob.writeUInt8(PAGE_SHIFT, cd + 39);
  for (let slot = 0; slot < slots; slot++) {
    const page = code.subarray(slot * pageSize, Math.min((slot + 1) * pageSize, codeLength));
    createHash("sha256")
      .update(page)
      .digest()
      .copy(blob, cd + 44 + slot * 32);
  }
  return Buffer.concat([code, blob]);
}

describe("macOS release binary signature check", () => {
  test("accepts an ad-hoc signed executable whose pages match the signature", () => {
    for (const arch of ["arm64", "x64"] as const) {
      const report = inspectMacosBinary(machO({ arch }), arch);
      expect(report.problems).toEqual([]);
      expect(report.arch).toBe(arch);
      expect(report.codeDirectories).toBe(1);
    }
  });

  test("rejects an unsigned executable", () => {
    expect(inspectMacosBinary(machO({ signed: false }), "arm64").problems).toEqual([
      "no LC_CODE_SIGNATURE load command (binary is unsigned)",
    ]);
  });

  test("rejects a binary changed after signing", () => {
    const bytes = machO();
    bytes[5000] = bytes[5000]! ^ 0xff;
    expect(inspectMacosBinary(bytes, "arm64").problems).toEqual([
      "page 1 (offset 4096) does not match its sha256 hash",
    ]);
  });

  test("rejects a binary for the wrong architecture", () => {
    expect(inspectMacosBinary(machO({ arch: "x64" }), "arm64").problems[0]).toContain(
      "is not arm64",
    );
  });

  test("rejects a signature without the ad-hoc flag", () => {
    expect(inspectMacosBinary(machO({ adHoc: false }), "arm64").problems).toEqual([
      "CodeDirectory is not an ad-hoc signature",
    ]);
  });

  test("rejects a truncated signature and non-Mach-O input", () => {
    const bytes = machO();
    expect(inspectMacosBinary(bytes.subarray(0, bytes.length - 10), "arm64").problems).toEqual([
      "code signature exceeds the file",
    ]);
    expect(
      inspectMacosBinary(Buffer.from("#!/bin/sh\necho subkit\n".padEnd(64)), "arm64").problems,
    ).toEqual(["not a 64-bit little-endian Mach-O file"]);
  });

  test("derives the expected architecture from the release file name", () => {
    expect(expectedArchFromName("assets/subkit-darwin-arm64")).toBe("arm64");
    expect(expectedArchFromName("assets/subkit-darwin-x64")).toBe("x64");
    expect(() => expectedArchFromName("assets/subkit-linux-x64")).toThrow();
  });
});
