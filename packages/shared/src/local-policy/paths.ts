import type { DeviceOs } from "../device/protocol.ts";
import { ALLOW, type PolicyResult, refuse } from "./result.ts";

export interface PathOptions {
  readonly os: DeviceOs;
  readonly case_sensitive?: boolean;
  readonly data_dir?: string | null;
}

export interface RootOptions extends PathOptions {
  readonly home?: string | null;
}

export const FILE_LIMITS = Object.freeze({
  list_entries: 500,
  read_text_bytes: 256 * 1024,
  import_bytes: 90 * 1024 * 1024,
  write_bytes: 10 * 1024 * 1024,
  batch_items: 200,
  download_bytes: 90 * 1024 * 1024,
});

export type FileLimit = keyof typeof FILE_LIMITS;

export const PROTECTED_SEGMENTS: ReadonlySet<string> = new Set([
  "library",
  "appdata",
  "$recycle.bin",
  "system volume information",
  "backups.backupdb",
  "com.apple.timemachine.localsnapshots",
]);

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/;

const WINDOWS_ILLEGAL = /[<>:"|?*]/;

export const SECRET_EXTENSIONS: ReadonlySet<string> = new Set([
  "pem",
  "key",
  "p12",
  "pfx",
  "p8",
  "kdbx",
  "kdb",
  "keychain",
  "keychain-db",
  "ovpn",
  "tfstate",
  "jks",
  "keystore",
  "ppk",
  "wallet",
]);

export const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /^\.?env$/,
  /^\.env\./,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /\.tfstate\.backup$/,
  /^credentials.*\.csv$/,
  /^credentials$/,
  /^service-account.*\.json$/,
  /^client_secret.*\.json$/,
  /-key\.txt$/,
  /^wallet\.dat$/,
  /^utc--\d{4}-/,
  /^[._]?netrc$/,
  /^\.?pgpass$/,
  /^\.?npmrc$/,
  /^\.?git-credentials$/,
];

export const PROGRAM_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe",
  "msi",
  "msix",
  "msixbundle",
  "appx",
  "appxbundle",
  "bat",
  "cmd",
  "com",
  "scr",
  "pif",
  "cpl",
  "ps1",
  "psm1",
  "psd1",
  "vbs",
  "vbe",
  "js",
  "jse",
  "wsf",
  "wsh",
  "hta",
  "lnk",
  "url",
  "reg",
  "inf",
  "dll",
  "sys",
  "ocx",
  "jar",
  "sh",
  "bash",
  "zsh",
  "csh",
  "ksh",
  "fish",
  "command",
  "tool",
  "app",
  "pkg",
  "mpkg",
  "dmg",
  "scpt",
  "scptd",
  "applescript",
  "workflow",
  "terminal",
  "action",
  "prefpane",
  "kext",
  "dylib",
  "so",
  "run",
  "bin",
  "appimage",
  "deb",
  "rpm",
  "py",
  "pyw",
  "pl",
  "rb",
]);

export const DARWIN_SYSTEM_ROOTS: readonly string[] = [
  "system",
  "library",
  "private",
  "usr",
  "bin",
  "sbin",
  "etc",
  "var",
  "tmp",
  "dev",
  "cores",
  "opt",
  "applications",
  "network",
];

export const WINDOWS_SYSTEM_ROOTS: readonly string[] = [
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "$recycle.bin",
  "system volume information",
  "recovery",
  "boot",
];

function lower(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32);
}

function withoutTrailingDots(name: string): string {
  return lower(name).replace(/[. ]+$/, "");
}

function hasExtensionIn(name: string, extensions: ReadonlySet<string>): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && extensions.has(name.slice(dot + 1));
}

export function isSecretFile(name: string): boolean {
  const n = withoutTrailingDots(name);
  return hasExtensionIn(n, SECRET_EXTENSIONS) || SECRET_NAME_PATTERNS.some((p) => p.test(n));
}

export function hasProgramExtension(name: string): boolean {
  return hasExtensionIn(withoutTrailingDots(name), PROGRAM_EXTENSIONS);
}

export function isExecutable(name: string, mode: number | null): boolean {
  return hasProgramExtension(name) || ((mode ?? 0) & 0o111) !== 0;
}

function windowsSegmentRefused(segment: string): boolean {
  return (
    WINDOWS_ILLEGAL.test(segment) ||
    /[. ]$/.test(segment) ||
    WINDOWS_RESERVED.test(lower(segment)) ||
    /~\d/.test(segment)
  );
}

function segmentRefusal(segment: string, os: DeviceOs): PolicyResult {
  if (hasControlCharacter(segment)) return refuse("outside_allowance");
  if (os === "win32" && windowsSegmentRefused(segment)) return refuse("outside_allowance");
  if (segment.startsWith(".")) return refuse("hidden_path");
  if (PROTECTED_SEGMENTS.has(lower(segment))) return refuse("outside_allowance");
  return ALLOW;
}

function segmentsRefusal(segments: readonly string[], os: DeviceOs): PolicyResult {
  for (const segment of segments) {
    const result = segmentRefusal(segment, os);
    if (!result.ok) return result;
  }
  return segments.length > 0 && isSecretFile(segments[segments.length - 1] as string)
    ? refuse("secret_file")
    : ALLOW;
}

function splitPath(path: string, os: DeviceOs): string[] {
  return path.split(os === "win32" ? /[\\/]/ : "/").filter((part) => part !== "" && part !== ".");
}

function isAbsolute(path: string, os: DeviceOs): boolean {
  return path.startsWith("/") || (os === "win32" && path.startsWith("\\"));
}

export function classifyRelativePath(lexical: string, os: DeviceOs): PolicyResult {
  if (isAbsolute(lexical, os)) return refuse("outside_allowance");
  const segments = splitPath(lexical, os);
  if (segments.includes("..")) return refuse("outside_allowance");
  return segmentsRefusal(segments, os);
}

interface AbsolutePath {
  readonly prefix: string;
  readonly segments: readonly string[];
}

function absolute(prefix: string, rest: string, os: DeviceOs): AbsolutePath | null {
  const segments = splitPath(rest, os);
  return segments.includes("..") ? null : { prefix, segments };
}

function uncPath(rest: string): AbsolutePath | null {
  const parts = splitPath(rest, "win32");
  if (parts.length < 2) return null;
  const [server, share] = parts as [string, string];
  return absolute(`\\\\${lower(server)}\\${lower(share)}\\`, parts.slice(2).join("\\"), "win32");
}

const DRIVE = /^([a-z]):(?:\\|$)/i;

function parseAbsolute(path: string, os: DeviceOs): AbsolutePath | null {
  const normalized = path.normalize("NFC");
  if (os === "darwin") {
    return normalized.startsWith("/") ? absolute(normalized.slice(0, 1), normalized, os) : null;
  }
  const rest = normalized.replace(/\//g, "\\");
  if (rest.toLowerCase().startsWith("\\\\?\\unc\\")) return uncPath(rest.slice(8));
  const local = rest.startsWith("\\\\?\\") ? rest.slice(4) : rest;
  if (local.startsWith("\\\\")) return uncPath(local);
  const drive = DRIVE.exec(local);
  return drive ? absolute(`${lower(local.slice(0, 2))}\\`, local.slice(2), os) : null;
}

function sameSegment(left: string, right: string, sensitive: boolean): boolean {
  return sensitive ? left === right : lower(left) === lower(right);
}

function relativeSegments(
  inner: AbsolutePath,
  outer: AbsolutePath,
  sensitive: boolean,
): readonly string[] | null {
  if (inner.prefix !== outer.prefix) return null;
  const head = inner.segments.slice(0, outer.segments.length);
  if (head.length !== outer.segments.length) return null;
  const same = head.every((segment, index) =>
    sameSegment(segment, outer.segments[index] as string, sensitive),
  );
  return same ? inner.segments.slice(outer.segments.length) : null;
}

function contains(
  outer: string | null | undefined,
  inner: AbsolutePath,
  options: PathOptions,
): boolean {
  if (typeof outer !== "string") return false;
  const parsed = parseAbsolute(outer, options.os);
  return (
    parsed !== null && relativeSegments(inner, parsed, options.case_sensitive === true) !== null
  );
}

export function segmentsUnder(
  root: string,
  path: string,
  options: PathOptions,
): readonly string[] | null {
  const outer = parseAbsolute(root, options.os);
  const inner = parseAbsolute(path, options.os);
  if (outer === null || inner === null) return null;
  return relativeSegments(inner, outer, options.case_sensitive === true);
}

export function classifyPath(
  lexical: string,
  real: string,
  rootReal: string,
  options: PathOptions,
): PolicyResult {
  const lexicalResult = classifyRelativePath(lexical, options.os);
  if (!lexicalResult.ok) return lexicalResult;
  const root = parseAbsolute(rootReal, options.os);
  const target = parseAbsolute(real, options.os);
  if (root === null || target === null) return refuse("outside_allowance");
  const inner = relativeSegments(target, root, options.case_sensitive === true);
  if (inner === null || contains(options.data_dir, target, options)) {
    return refuse("outside_allowance");
  }
  return segmentsRefusal(inner, options.os);
}

function insideSystemRoot(root: AbsolutePath, os: DeviceOs): boolean {
  const first = lower(root.segments[0] as string);
  const depth = root.segments.length;
  if (first === "users" && depth === 1) return true;
  if (os === "win32") return WINDOWS_SYSTEM_ROOTS.includes(first);
  return DARWIN_SYSTEM_ROOTS.includes(first) || (first === "volumes" && depth <= 2);
}

export interface PersonalPathOptions extends PathOptions {
  readonly keep_out: readonly string[];
}

function personalRefusal(path: string, options: PersonalPathOptions): PolicyResult {
  const parsed = parseAbsolute(path, options.os);
  if (parsed === null || parsed.segments.length === 0) return refuse("outside_allowance");
  if (
    insideSystemRoot(parsed, options.os) ||
    contains(options.data_dir, parsed, options) ||
    options.keep_out.some((entry) => contains(entry, parsed, options))
  ) {
    return refuse("outside_allowance");
  }
  return segmentsRefusal(parsed.segments, options.os);
}

export function pathAllowedPersonal(
  lexical: string,
  real: string,
  options: PersonalPathOptions,
): PolicyResult {
  const lexicalResult = personalRefusal(lexical, options);
  return lexicalResult.ok ? personalRefusal(real, options) : lexicalResult;
}

export function classifyRoot(rootReal: string, options: RootOptions): PolicyResult {
  const root = parseAbsolute(rootReal, options.os);
  if (root === null || root.segments.length === 0) return refuse("outside_allowance");
  const sensitive = options.case_sensitive === true;
  const home = typeof options.home === "string" ? parseAbsolute(options.home, options.os) : null;
  if (home !== null && relativeSegments(home, root, sensitive) !== null) {
    return refuse("outside_allowance");
  }
  const dataDir =
    typeof options.data_dir === "string" ? parseAbsolute(options.data_dir, options.os) : null;
  if (
    dataDir !== null &&
    (relativeSegments(dataDir, root, sensitive) !== null ||
      relativeSegments(root, dataDir, sensitive) !== null)
  ) {
    return refuse("outside_allowance");
  }
  if (insideSystemRoot(root, options.os)) return refuse("outside_allowance");
  for (const segment of root.segments) {
    const result = segmentRefusal(segment, options.os);
    if (!result.ok) return result;
  }
  return ALLOW;
}

function extensionText(name: string): string {
  return lower(name).slice(name.lastIndexOf("."));
}

export function classifyNewEntry(
  name: string,
  os: DeviceOs,
  previousName: string | null = null,
): PolicyResult {
  if (name === "" || name === "." || name === "..") return refuse("outside_allowance");
  if (os === "win32" ? /[\\/]/.test(name) : name.includes("/")) return refuse("outside_allowance");
  const result = segmentsRefusal([name], os);
  if (!result.ok) return result;
  if (!hasProgramExtension(name)) return ALLOW;
  return previousName !== null && extensionText(previousName) === extensionText(name)
    ? ALLOW
    : refuse("executable");
}

export function classifyRootIdentity(expectedFileId: string, actualFileId: string): PolicyResult {
  return expectedFileId === actualFileId ? ALLOW : refuse("folder_changed");
}

export function classifyRecheck(
  preparedReal: string,
  currentReal: string,
  options: PathOptions,
): PolicyResult {
  const prepared = parseAbsolute(preparedReal, options.os);
  const current = parseAbsolute(currentReal, options.os);
  if (prepared === null || current === null) return refuse("path_moved");
  const rest = relativeSegments(current, prepared, options.case_sensitive === true);
  return rest !== null && rest.length === 0 ? ALLOW : refuse("path_moved");
}

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface OpenedFile {
  readonly path: FileIdentity;
  readonly opened: FileIdentity;
  readonly nlink: number;
  readonly is_file: boolean;
}

export function classifyOpenedFile(file: OpenedFile): PolicyResult {
  if (file.path.dev !== file.opened.dev || file.path.ino !== file.opened.ino) {
    return refuse("path_moved");
  }
  if (file.is_file && file.nlink > 1) return refuse("outside_allowance");
  return ALLOW;
}

export interface FileVersion extends FileIdentity {
  readonly size: number;
  readonly mtime_ms: number;
  readonly ctime_ms: number;
}

export function fileVersionTag(version: FileVersion): string {
  return [version.dev, version.ino, version.size, version.mtime_ms, version.ctime_ms].join(":");
}

export function classifyReadVersion(before: FileVersion, after: FileVersion): PolicyResult {
  return fileVersionTag(before) === fileVersionTag(after) ? ALLOW : refuse("stale");
}

export function classifySize(limit: FileLimit, value: number): PolicyResult {
  if (!Number.isFinite(value) || value < 0) return refuse("too_large");
  if (limit === "download_bytes" && value < 1) return refuse("too_large");
  return value <= FILE_LIMITS[limit] ? ALLOW : refuse("too_large");
}
