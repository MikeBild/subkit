import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename } from "node:path";
import type { FileListEntry, FileTarget } from "@shared/device/files.ts";
import type { DeviceResult } from "@shared/device/protocol.ts";
import {
  classifyReadVersion,
  classifyRelativePath,
  classifySize,
  FILE_LIMITS,
  type FileLimit,
} from "@shared/local-policy/paths.ts";
import type { SnapshotFolder } from "../../shared/local/files-allowances.ts";
import { failed, failureOfError, refused } from "../../shared/local/files-policy.ts";
import { type OpContext, resultOf } from "./context.ts";
import { openVerified, type Resolved, recheck, resolveTarget, versionHash } from "./resolve.ts";

const CHUNK_BYTES = 1024 * 1024;

function version(stats: Stats) {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtime_ms: stats.mtimeMs,
    ctime_ms: stats.ctimeMs,
  };
}

async function prepared(
  context: OpContext,
  target: FileTarget,
  folder: SnapshotFolder | null,
): Promise<{ ok: true; value: Resolved } | { ok: false; result: DeviceResult }> {
  const kind = context.command.kind;
  const first = await resolveTarget(context.resolve, target, folder, "read", kind);
  if (!first.ok) return { ok: false, result: resultOf(first) };
  await context.deps.hooks?.afterPrepare?.(first.value.real);
  const second = await recheck(context.resolve, first.value, kind);
  if (!second.ok) return { ok: false, result: resultOf(second) };
  if (context.signal.aborted) return { ok: false, result: { status: "stopped" } };
  return { ok: true, value: second.value };
}

function kindOf(stats: Stats): FileListEntry["kind"] {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "folder";
  if (stats.isSymbolicLink()) return "link";
  return "other";
}

export async function listFolder(
  context: OpContext,
  target: FileTarget,
  folder: SnapshotFolder | null,
): Promise<DeviceResult> {
  const ready = await prepared(context, target, folder);
  if (!ready.ok) return ready.result;
  const resolved = ready.value;
  try {
    const before = await lstat(resolved.real);
    if (!before.isDirectory()) return failed("not_a_folder");
    const names = (await readdir(resolved.real)).sort();
    const visible = names.filter((name) => classifyRelativePath(name, "darwin").ok);
    const shown = visible.slice(0, FILE_LIMITS.list_entries);
    const entries: FileListEntry[] = [];
    for (const name of shown) {
      const stats = await lstat(`${resolved.real}/${name}`).catch(() => null);
      if (!stats) continue;
      entries.push({
        name,
        kind: kindOf(stats),
        size: stats.isFile() ? stats.size : 0,
        modified_at: new Date(stats.mtimeMs).toISOString(),
      });
    }
    const after = await lstat(resolved.real);
    const same = classifyReadVersion(version(before), version(after));
    if (!same.ok) return refused(same.code);
    return {
      status: "done",
      output: {
        entries,
        truncated: visible.length > shown.length,
        omitted: names.length - visible.length,
      },
      evidence: { before_version: versionHash(before), after_version: versionHash(after) },
    };
  } catch (error) {
    return failed(failureOfError(error));
  }
}

interface ReadOutcome {
  readonly size: number;
  readonly sha256: string;
  readonly before: Stats;
  readonly after: Stats;
}

async function readVerified(
  context: OpContext,
  resolved: Resolved,
  limit: FileLimit,
  onChunk: (chunk: Uint8Array) => Promise<void>,
): Promise<{ ok: true; value: ReadOutcome } | { ok: false; result: DeviceResult }> {
  const opened = await openVerified(resolved);
  if (!opened.ok) return { ok: false, result: resultOf(opened) };
  const { handle, stats: before } = opened.value;
  try {
    if (!before.isFile()) return { ok: false, result: failed("not_a_file") };
    const size = classifySize(limit, before.size);
    if (!size.ok) return { ok: false, result: refused(size.code) };
    const hash = createHash("sha256");
    const buffer = new Uint8Array(CHUNK_BYTES);
    let total = 0;
    for (;;) {
      if (context.signal.aborted) return { ok: false, result: { status: "stopped" } };
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > FILE_LIMITS[limit]) return { ok: false, result: refused("too_large") };
      const chunk = buffer.slice(0, bytesRead);
      hash.update(chunk);
      await onChunk(chunk);
      if (total === bytesRead) await context.deps.hooks?.duringRead?.(resolved.real);
      context.tick(`read ${total} bytes`);
    }
    const after = await handle.stat();
    const same = classifyReadVersion(version(before), version(after));
    if (!same.ok || total !== after.size) return { ok: false, result: refused("stale") };
    return { ok: true, value: { size: total, sha256: hash.digest("hex"), before, after } };
  } catch (error) {
    return { ok: false, result: failed(failureOfError(error)) };
  } finally {
    await handle.close();
  }
}

export async function readText(
  context: OpContext,
  target: FileTarget,
  folder: SnapshotFolder | null,
): Promise<DeviceResult> {
  const ready = await prepared(context, target, folder);
  if (!ready.ok) return ready.result;
  const chunks: Uint8Array[] = [];
  const read = await readVerified(context, ready.value, "read_text_bytes", async (chunk) => {
    chunks.push(chunk);
  });
  if (!read.ok) return read.result;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return failed("not_text");
  }
  return {
    status: "done",
    output: { text, size: read.value.size, sha256: read.value.sha256 },
    evidence: {
      before_version: versionHash(read.value.before),
      after_version: versionHash(read.value.after),
    },
  };
}

export async function importFile(
  context: OpContext,
  target: FileTarget,
  folder: SnapshotFolder | null,
  name: string | undefined,
): Promise<DeviceResult> {
  const importer = context.deps.importer;
  if (!importer) return failed("import_unavailable");
  const ready = await prepared(context, target, folder);
  if (!ready.ok) return ready.result;
  const resolved = ready.value;
  const size = resolved.stats?.size ?? 0;
  const precheck = classifySize("import_bytes", size);
  if (!precheck.ok) return refused(precheck.code);
  const fileName = name ?? basename(resolved.real);
  const session = await importer.begin({
    command_id: context.command.command_id,
    name: fileName,
    size,
  });
  if (!session) return failed("import_failed");
  const read = await readVerified(context, resolved, "import_bytes", (chunk) =>
    session.write(chunk),
  );
  if (!read.ok) {
    await session.abort();
    return read.result;
  }
  const committed = await session.commit(read.value.sha256).catch(() => null);
  if (!committed) return failed("import_failed");
  return {
    status: "done",
    output: {
      file_id: committed.file_id,
      name: fileName,
      size: read.value.size,
      sha256: read.value.sha256,
    },
    evidence: {
      before_version: versionHash(read.value.before),
      after_version: versionHash(read.value.after),
    },
  };
}
