import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

const INVISIBLE_STRIP = /[​-‏﻿]/g;
const NBSP = / /g;
const SUSPICIOUS = /[ ​-‏﻿]/;

export function sanitizePathInput(s: string): string {
  return s.replace(INVISIBLE_STRIP, "").replace(NBSP, " ").trim();
}

export function renderSuspiciousCodepoints(s: string): string {
  if (!SUSPICIOUS.test(s)) return "";
  const cps = [...s].map((c) => c.codePointAt(0)?.toString(16)).join(" ");
  return ` [codepoints: ${cps}]`;
}

export type RegularFileRead =
  | { kind: "file"; bytes: Buffer }
  | { kind: "missing" }
  | { kind: "not_file" };

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);
const NOT_FILE_CODES = new Set(["EISDIR", "ELOOP"]);

function openForRead(
  path: string,
  followSymlinks: boolean,
): number | { kind: "missing" } | { kind: "not_file" } {
  const noFollow = followSymlinks ? 0 : (constants.O_NOFOLLOW ?? 0);
  try {
    return openSync(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (MISSING_CODES.has(code)) return { kind: "missing" };
    if (NOT_FILE_CODES.has(code)) return { kind: "not_file" };
    throw error;
  }
}

export type RegularFileStat =
  | { kind: "file"; size: number }
  | { kind: "missing" }
  | { kind: "not_file" };

export function statRegularFile(path: string): RegularFileStat {
  const opened = openForRead(path, true);
  if (typeof opened !== "number") return opened;
  try {
    const stat = fstatSync(opened);
    return stat.isFile() ? { kind: "file", size: stat.size } : { kind: "not_file" };
  } finally {
    closeSync(opened);
  }
}

export function readRegularFile(
  path: string,
  opts: { followSymlinks?: boolean } = {},
): RegularFileRead {
  const opened = openForRead(path, opts.followSymlinks ?? true);
  if (typeof opened !== "number") return opened;
  try {
    if (!fstatSync(opened).isFile()) return { kind: "not_file" };
    return { kind: "file", bytes: readFileSync(opened) };
  } finally {
    closeSync(opened);
  }
}
