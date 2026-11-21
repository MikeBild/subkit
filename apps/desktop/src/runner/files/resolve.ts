import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { FileTarget } from "@shared/device/files.ts";
import type { DeviceCommandKind, DeviceRefusal } from "@shared/device/protocol.ts";
import {
  classifyOpenedFile,
  classifyPath,
  classifyRecheck,
  classifyRelativePath,
  classifyRoot,
  classifyRootIdentity,
  fileVersionTag,
  hasProgramExtension,
  isExecutable,
  pathAllowedPersonal,
} from "@shared/local-policy/paths.ts";
import type { PolicyResult } from "@shared/local-policy/result.ts";
import {
  type FilesSnapshot,
  folderDigest,
  type SnapshotFolder,
} from "../../shared/local/files-allowances.ts";
import {
  type FilesFailure,
  failureOfError,
  needsSegment,
} from "../../shared/local/files-policy.ts";

export interface FilesPolicy {
  readonly classifyRoot: typeof classifyRoot;
  readonly pathAllowedPersonal: typeof pathAllowedPersonal;
}

export const DEFAULT_POLICY: FilesPolicy = { classifyRoot, pathAllowedPersonal };

export type VolumeIdOf = (path: string, dev: number) => Promise<string>;

export const DEV_VOLUME_ID: VolumeIdOf = async (_path, dev) => String(dev);

export interface ResolveContext {
  readonly device_id: string;
  readonly snapshot: FilesSnapshot;
  readonly policy: FilesPolicy;
  readonly volume_id: VolumeIdOf;
}

export type Intent = "read" | "mutate" | "create";

export interface Resolved {
  readonly target: FileTarget;
  readonly intent: Intent;
  readonly folder: SnapshotFolder | null;
  readonly root_real: string | null;
  readonly real: string;
  readonly name: string;
  readonly parent_real: string;
  readonly case_sensitive: boolean;
  readonly stats: Stats | null;
}

export type Step<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal?: DeviceRefusal; readonly failure?: FilesFailure };

export function refusal<T>(code: DeviceRefusal): Step<T> {
  return { ok: false, refusal: code };
}

export function failure<T>(code: FilesFailure): Step<T> {
  return { ok: false, failure: code };
}

function fromPolicy<T>(result: PolicyResult): Step<T> | null {
  return result.ok ? null : refusal(result.code);
}

function code(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw error;
  }
}

function toggledCase(name: string): string {
  return [...name]
    .map((character) =>
      character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase(),
    )
    .join("");
}

export async function probeCaseSensitive(dir: string): Promise<boolean> {
  const name = basename(dir);
  const toggled = toggledCase(name);
  if (dir === "/" || toggled === name) return false;
  const [original, other] = await Promise.all([
    lstatOrNull(dir),
    lstatOrNull(join(dirname(dir), toggled)),
  ]);
  if (!original || !other) return true;
  return original.ino !== other.ino || original.dev !== other.dev;
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

export function hashHex(material: string | Uint8Array): string {
  return createHash("sha256").update(material).digest("hex");
}

export function versionHash(stats: Stats): string {
  return hashHex(
    fileVersionTag({
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtime_ms: stats.mtimeMs,
      ctime_ms: stats.ctimeMs,
    }),
  );
}

function leafRefusal(name: string, stats: Stats | null, intent: Intent): DeviceRefusal | null {
  if (!stats) return null;
  if (intent !== "read" && stats.isFile() && stats.nlink > 1) return "outside_allowance";
  if (stats.isFile() && isExecutable(name, stats.mode)) return "executable";
  if (stats.isDirectory() && hasProgramExtension(name)) return "executable";
  return null;
}

interface Leaf {
  readonly parent_real: string;
  readonly name: string;
  readonly real: string;
  readonly stats: Stats | null;
}

async function leafOf(parentPath: string, name: string, intent: Intent): Promise<Step<Leaf>> {
  const parentReal = await realpath(parentPath);
  const candidate = parentReal === "/" ? `/${name}` : `${parentReal}/${name}`;
  const stats = await lstatOrNull(candidate);
  if (!stats) {
    return intent === "create"
      ? { ok: true, value: { parent_real: parentReal, name, real: candidate, stats: null } }
      : failure("not_found");
  }
  if (!stats.isSymbolicLink()) {
    return { ok: true, value: { parent_real: parentReal, name, real: candidate, stats } };
  }
  if (intent !== "read") return refusal("outside_allowance");
  const real = await realpath(candidate);
  return {
    ok: true,
    value: { parent_real: dirname(real), name: basename(real), real, stats: await lstat(real) },
  };
}

async function resolveFolder(
  context: ResolveContext,
  target: Extract<FileTarget, { folder_id: string }>,
  folder: SnapshotFolder,
  intent: Intent,
  kind: DeviceCommandKind,
): Promise<Step<Resolved>> {
  const lexical = fromPolicy<Resolved>(classifyRelativePath(target.path, "darwin"));
  if (lexical) return lexical;
  const segments = segmentsOf(target.path);
  const segment = fromPolicy<Resolved>(needsSegment(segments.length, kind));
  if (segment) return segment;
  let rootReal: string;
  try {
    rootReal = await realpath(folder.path);
  } catch {
    return refusal("folder_changed");
  }
  if (rootReal !== folder.path) return refusal("folder_changed");
  const caseSensitive = await probeCaseSensitive(rootReal);
  const rootVerdict = fromPolicy<Resolved>(
    context.policy.classifyRoot(rootReal, {
      os: "darwin",
      case_sensitive: caseSensitive,
      home: context.snapshot.home,
      data_dir: context.snapshot.data_dir,
    }),
  );
  if (rootVerdict) return rootVerdict;
  let leaf: Leaf;
  if (segments.length === 0) {
    leaf = {
      parent_real: dirname(rootReal),
      name: basename(rootReal),
      real: rootReal,
      stats: await lstat(rootReal),
    };
  } else {
    const found = await leafOf(
      join(rootReal, ...segments.slice(0, -1)),
      segments[segments.length - 1] as string,
      intent,
    );
    if (!found.ok) return found;
    leaf = found.value;
  }
  const inside = fromPolicy<Resolved>(
    classifyPath(target.path, leaf.real, rootReal, {
      os: "darwin",
      case_sensitive: caseSensitive,
      data_dir: context.snapshot.data_dir,
    }),
  );
  if (inside) return inside;
  const executable = segments.length > 0 ? leafRefusal(leaf.name, leaf.stats, intent) : null;
  if (executable) return refusal(executable);
  const rootStats = await stat(rootReal);
  const identity = fromPolicy<Resolved>(
    classifyRootIdentity(
      folderDigest(context.device_id, folder),
      folderDigest(context.device_id, {
        path: rootReal,
        volume_id: await context.volume_id(rootReal, rootStats.dev),
        file_id: String(rootStats.ino),
      }),
    ),
  );
  if (identity) return identity;
  return {
    ok: true,
    value: {
      target,
      intent,
      folder,
      root_real: rootReal,
      real: leaf.real,
      name: leaf.name,
      parent_real: leaf.parent_real,
      case_sensitive: caseSensitive,
      stats: leaf.stats,
    },
  };
}

async function resolveAbsolute(
  context: ResolveContext,
  target: Extract<FileTarget, { absolute: string }>,
  intent: Intent,
  kind: DeviceCommandKind,
): Promise<Step<Resolved>> {
  const path = target.absolute;
  const snapshot = context.snapshot;
  const keepOut = snapshot.keep_out.map((entry) => entry.path);
  const options = (caseSensitive: boolean) => ({
    os: "darwin" as const,
    case_sensitive: caseSensitive,
    data_dir: snapshot.data_dir,
    keep_out: keepOut,
  });
  const lexical = fromPolicy<Resolved>(
    context.policy.pathAllowedPersonal(path, path, options(false)),
  );
  if (lexical) return lexical;
  const segments = segmentsOf(path);
  const segment = fromPolicy<Resolved>(needsSegment(segments.length, kind));
  if (segment) return segment;
  if (segments.length === 0) return refusal("outside_allowance");
  const found = await leafOf(dirname(path), segments[segments.length - 1] as string, intent);
  if (!found.ok) return found;
  const leaf = found.value;
  const caseSensitive = await probeCaseSensitive(leaf.parent_real);
  const home = snapshot.home;
  const sameAsHome =
    home !== null &&
    (caseSensitive ? leaf.real === home : leaf.real.toLowerCase() === home.toLowerCase());
  if (sameAsHome) return refusal("outside_allowance");
  const real = fromPolicy<Resolved>(
    context.policy.pathAllowedPersonal(path, leaf.real, options(caseSensitive)),
  );
  if (real) return real;
  const executable = leafRefusal(leaf.name, leaf.stats, intent);
  if (executable) return refusal(executable);
  return {
    ok: true,
    value: {
      target,
      intent,
      folder: null,
      root_real: null,
      real: leaf.real,
      name: leaf.name,
      parent_real: leaf.parent_real,
      case_sensitive: caseSensitive,
      stats: leaf.stats,
    },
  };
}

export async function resolveTarget(
  context: ResolveContext,
  target: FileTarget,
  folder: SnapshotFolder | null,
  intent: Intent,
  kind: DeviceCommandKind,
): Promise<Step<Resolved>> {
  try {
    if ("folder_id" in target) {
      if (!folder) return refusal("outside_allowance");
      return await resolveFolder(context, target, folder, intent, kind);
    }
    return await resolveAbsolute(context, target, intent, kind);
  } catch (error) {
    if (code(error) === "ELOOP") return refusal("path_moved");
    return failure(failureOfError(error));
  }
}

export async function recheck(
  context: ResolveContext,
  prepared: Resolved,
  kind: DeviceCommandKind,
): Promise<Step<Resolved>> {
  const current = await resolveTarget(
    context,
    prepared.target,
    prepared.folder,
    prepared.intent,
    kind,
  );
  if (!current.ok) return current.failure === "not_found" ? refusal("path_moved") : current;
  const moved = classifyRecheck(prepared.real, current.value.real, {
    os: "darwin",
    case_sensitive: prepared.case_sensitive,
  });
  if (!moved.ok) return refusal(moved.code);
  const before = prepared.stats;
  const after = current.value.stats;
  if ((before === null) !== (after === null)) return refusal("path_moved");
  if (before && after && (before.ino !== after.ino || before.dev !== after.dev)) {
    return refusal("path_moved");
  }
  return current;
}

export interface Opened {
  readonly handle: FileHandle;
  readonly stats: Stats;
}

export async function openVerified(resolved: Resolved): Promise<Step<Opened>> {
  let handle: FileHandle;
  try {
    handle = await open(resolved.real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (code(error) === "ELOOP") return refusal("path_moved");
    return failure(failureOfError(error));
  }
  try {
    const opened = await handle.stat();
    const path = await lstat(resolved.real);
    const identity = classifyOpenedFile({
      path: { dev: path.dev, ino: path.ino },
      opened: { dev: opened.dev, ino: opened.ino },
      nlink: opened.nlink,
      is_file: opened.isFile(),
    });
    if (!identity.ok) {
      await handle.close();
      return refusal(identity.code);
    }
    const again = classifyRecheck(resolved.real, await realpath(resolved.real), {
      os: "darwin",
      case_sensitive: resolved.case_sensitive,
    });
    if (!again.ok) {
      await handle.close();
      return refusal(again.code);
    }
    return { ok: true, value: { handle, stats: opened } };
  } catch (error) {
    await handle.close();
    return failure(failureOfError(error));
  }
}
