import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const MH_EXECUTE = 2;
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSSLOT_CODEDIRECTORY = 0;
const CSSLOT_ALTERNATE_CODEDIRECTORIES = 0x1000;
const CS_ADHOC = 0x2;
const CS_HASHTYPE_SHA1 = 1;
const CS_HASHTYPE_SHA256 = 2;

export const MACHO_CPU_TYPES = { arm64: 0x0100000c, x64: 0x01000007 } as const;

export type MacosArch = keyof typeof MACHO_CPU_TYPES;

export interface MacosBinaryReport {
  arch: MacosArch | null;
  signatureOffset: number | null;
  codeDirectories: number;
  problems: string[];
}

interface CodeDirectory {
  flags: number;
  hashOffset: number;
  nCodeSlots: number;
  codeLimit: number;
  hashSize: number;
  hashType: number;
  pageSize: number;
  start: number;
  length: number;
}

function readCodeDirectory(bytes: Buffer, start: number, end: number): CodeDirectory | string {
  if (start + 44 > end) return `CodeDirectory at ${start} is truncated`;
  if (bytes.readUInt32BE(start) !== CSMAGIC_CODEDIRECTORY) {
    return `blob at ${start} is not a CodeDirectory`;
  }
  const length = bytes.readUInt32BE(start + 4);
  if (start + length > end) return `CodeDirectory at ${start} exceeds the signature`;
  return {
    start,
    length,
    flags: bytes.readUInt32BE(start + 12),
    hashOffset: bytes.readUInt32BE(start + 16),
    nCodeSlots: bytes.readUInt32BE(start + 28),
    codeLimit: bytes.readUInt32BE(start + 32),
    hashSize: bytes.readUInt8(start + 36),
    hashType: bytes.readUInt8(start + 37),
    pageSize: bytes.readUInt8(start + 39),
  };
}

function verifyCodeDirectory(
  bytes: Buffer,
  cd: CodeDirectory,
  signatureOffset: number,
): string | null {
  const algorithm =
    cd.hashType === CS_HASHTYPE_SHA256
      ? "sha256"
      : cd.hashType === CS_HASHTYPE_SHA1
        ? "sha1"
        : null;
  if (!algorithm) return `CodeDirectory uses unsupported hash type ${cd.hashType}`;
  if (cd.hashSize !== (algorithm === "sha256" ? 32 : 20)) {
    return `CodeDirectory hash size ${cd.hashSize} does not match ${algorithm}`;
  }
  if ((cd.flags & CS_ADHOC) === 0) return "CodeDirectory is not an ad-hoc signature";
  if (cd.codeLimit !== signatureOffset) {
    return `signature covers ${cd.codeLimit} bytes, expected ${signatureOffset}`;
  }
  if (cd.pageSize === 0 || cd.pageSize > 30) return `invalid page size 2^${cd.pageSize}`;
  const pageSize = 2 ** cd.pageSize;
  const expectedSlots = Math.ceil(cd.codeLimit / pageSize);
  if (cd.nCodeSlots !== expectedSlots) {
    return `CodeDirectory has ${cd.nCodeSlots} page hashes, expected ${expectedSlots}`;
  }
  const hashesStart = cd.start + cd.hashOffset;
  if (
    cd.hashOffset > cd.length ||
    hashesStart + cd.nCodeSlots * cd.hashSize > cd.start + cd.length
  ) {
    return "CodeDirectory page hashes exceed the blob";
  }
  for (let slot = 0; slot < cd.nCodeSlots; slot++) {
    const pageStart = slot * pageSize;
    const page = bytes.subarray(pageStart, Math.min(pageStart + pageSize, cd.codeLimit));
    const actual = createHash(algorithm).update(page).digest();
    const stored = bytes.subarray(
      hashesStart + slot * cd.hashSize,
      hashesStart + (slot + 1) * cd.hashSize,
    );
    if (!actual.equals(stored)) {
      return `page ${slot} (offset ${pageStart}) does not match its ${algorithm} hash`;
    }
  }
  return null;
}

export function inspectMacosBinary(input: Uint8Array, expectedArch: MacosArch): MacosBinaryReport {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const report: MacosBinaryReport = {
    arch: null,
    signatureOffset: null,
    codeDirectories: 0,
    problems: [],
  };
  const fail = (problem: string): MacosBinaryReport => {
    report.problems.push(problem);
    return report;
  };
  if (bytes.length < 32) return fail("file is too small for a Mach-O header");
  if (bytes.readUInt32BE(0) === FAT_MAGIC) return fail("universal binaries are not expected");
  if (bytes.readUInt32LE(0) !== MH_MAGIC_64) return fail("not a 64-bit little-endian Mach-O file");
  const cpuType = bytes.readUInt32LE(4);
  const arch = (Object.keys(MACHO_CPU_TYPES) as MacosArch[]).find(
    (name) => MACHO_CPU_TYPES[name] === cpuType,
  );
  report.arch = arch ?? null;
  if (arch !== expectedArch) {
    return fail(`cpu type 0x${cpuType.toString(16)} is not ${expectedArch}`);
  }
  if (bytes.readUInt32LE(12) !== MH_EXECUTE) return fail("Mach-O file is not an executable");
  const ncmds = bytes.readUInt32LE(16);
  const sizeofcmds = bytes.readUInt32LE(20);
  if (32 + sizeofcmds > bytes.length) return fail("load commands exceed the file");

  let signature: { dataoff: number; datasize: number } | null = null;
  let cursor = 32;
  for (let i = 0; i < ncmds; i++) {
    if (cursor + 8 > 32 + sizeofcmds) return fail(`load command ${i} is truncated`);
    const cmd = bytes.readUInt32LE(cursor);
    const cmdsize = bytes.readUInt32LE(cursor + 4);
    if (cmdsize < 8 || cursor + cmdsize > 32 + sizeofcmds) {
      return fail(`load command ${i} has an invalid size`);
    }
    if (cmd === LC_CODE_SIGNATURE) {
      if (cmdsize < 16) return fail("LC_CODE_SIGNATURE is truncated");
      signature = {
        dataoff: bytes.readUInt32LE(cursor + 8),
        datasize: bytes.readUInt32LE(cursor + 12),
      };
    }
    cursor += cmdsize;
  }
  if (!signature) return fail("no LC_CODE_SIGNATURE load command (binary is unsigned)");
  report.signatureOffset = signature.dataoff;
  const end = signature.dataoff + signature.datasize;
  if (signature.datasize < 12 || end > bytes.length) return fail("code signature exceeds the file");
  if (bytes.readUInt32BE(signature.dataoff) !== CSMAGIC_EMBEDDED_SIGNATURE) {
    return fail("code signature is not an embedded signature SuperBlob");
  }
  const count = bytes.readUInt32BE(signature.dataoff + 8);
  if (signature.dataoff + 12 + count * 8 > end)
    return fail("SuperBlob index exceeds the signature");

  let sha256Directories = 0;
  for (let i = 0; i < count; i++) {
    const entry = signature.dataoff + 12 + i * 8;
    const type = bytes.readUInt32BE(entry);
    const isDirectory =
      type === CSSLOT_CODEDIRECTORY ||
      (type >= CSSLOT_ALTERNATE_CODEDIRECTORIES && type < CSSLOT_ALTERNATE_CODEDIRECTORIES + 5);
    if (!isDirectory) continue;
    const cd = readCodeDirectory(bytes, signature.dataoff + bytes.readUInt32BE(entry + 4), end);
    if (typeof cd === "string") return fail(cd);
    report.codeDirectories += 1;
    const problem = verifyCodeDirectory(bytes, cd, signature.dataoff);
    if (problem) return fail(problem);
    if (cd.hashType === CS_HASHTYPE_SHA256) sha256Directories += 1;
  }
  if (report.codeDirectories === 0) return fail("code signature has no CodeDirectory");
  if (sha256Directories === 0) return fail("code signature has no SHA-256 CodeDirectory");
  return report;
}

export function expectedArchFromName(path: string): MacosArch {
  const match = /_darwin_(arm64|x64)$/.exec(basename(path));
  if (!match) throw new Error(`${path}: expected a name ending in _darwin_arm64 or _darwin_x64`);
  return match[1] as MacosArch;
}

function main(paths: string[]): number {
  if (paths.length === 0) {
    console.error("usage: bun scripts/verify-macos-binaries.ts <sk_darwin_arm64> <sk_darwin_x64>");
    return 2;
  }
  let failed = 0;
  for (const path of paths) {
    const report = inspectMacosBinary(readFileSync(path), expectedArchFromName(path));
    if (report.problems.length > 0) {
      failed += 1;
      console.error(`FAIL ${path}: ${report.problems.join("; ")}`);
    } else {
      console.log(
        `PASS ${path}: ${report.arch} executable, ad-hoc signature at ${report.signatureOffset} covers every page (${report.codeDirectories} CodeDirectory)`,
      );
    }
  }
  return failed > 0 ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exit(main(Bun.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
