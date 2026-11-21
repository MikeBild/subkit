import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import type { FileContent, FileTarget } from "@shared/device/files.ts";
import type { DeviceResult } from "@shared/device/protocol.ts";
import { classifyNewEntry, classifySize } from "@shared/local-policy/paths.ts";
import { OWN_TEMP_NAME, type SnapshotFolder } from "../../shared/local/files-allowances.ts";
import { failed, failureOfError, refused } from "../../shared/local/files-policy.ts";
import { type OpContext, resultOf, sendToTrash } from "./context.ts";
import { type Resolved, recheck, resolveTarget, versionHash } from "./resolve.ts";

export async function discardOwn(path: string, ino: number): Promise<void> {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!OWN_TEMP_NAME.test(name)) return;
  const stats = await lstat(path).catch(() => null);
  if (stats?.isFile() && stats.ino === ino) await unlink(path).catch(() => {});
}

async function syncFolder(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function bytesOf(content: FileContent): Uint8Array {
  return content.encoding === "utf8"
    ? new TextEncoder().encode(content.text)
    : new Uint8Array(Buffer.from(content.data, "base64"));
}

async function writeTemp(
  parent: string,
  id: string,
  bytes: Uint8Array,
): Promise<{ path: string; ino: number }> {
  const path = `${parent}/.subkit-${id}.tmp`;
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    return { path, ino: (await handle.stat()).ino };
  } finally {
    await handle.close();
  }
}

async function prepareNew(
  context: OpContext,
  target: FileTarget,
  folder: SnapshotFolder | null,
): Promise<{ ok: true; value: Resolved } | { ok: false; result: DeviceResult }> {
  const resolved = await resolveTarget(
    context.resolve,
    target,
    folder,
    "create",
    context.command.kind,
  );
  if (!resolved.ok) return { ok: false, result: resultOf(resolved) };
  return { ok: true, value: resolved.value };
}

interface Placement {
  readonly replaced: boolean;
  readonly before: string | undefined;
}

async function place(
  context: OpContext,
  resolved: Resolved,
  temp: { path: string; ino: number },
): Promise<{ ok: true; value: Placement } | { ok: false; result: DeviceResult }> {
  const hooks = context.deps.hooks;
  if (!resolved.stats) {
    await hooks?.beforePlace?.(resolved.real);
    try {
      await link(temp.path, resolved.real);
    } catch (error) {
      return { ok: false, result: failed(failureOfError(error)) };
    }
    return { ok: true, value: { replaced: false, before: undefined } };
  }
  const before = versionHash(resolved.stats);
  const backup = `${resolved.parent_real}/.subkit-${context.newId()}.bak`;
  await link(resolved.real, backup);
  const backupIno = resolved.stats.ino;
  const trashed = await sendToTrash(context, resolved.real, backupIno);
  if (!trashed) {
    await discardOwn(backup, backupIno);
    return { ok: false, result: refused("trash_unavailable") };
  }
  await hooks?.beforePlace?.(resolved.real);
  try {
    await link(temp.path, resolved.real);
  } catch (error) {
    const restored = await link(backup, resolved.real).then(
      () => true,
      () => false,
    );
    if (restored) await discardOwn(backup, backupIno);
    return { ok: false, result: failed(restored ? failureOfError(error) : "restore_failed") };
  }
  await discardOwn(backup, backupIno);
  return { ok: true, value: { replaced: true, before } };
}

export async function writeFile(
  context: OpContext,
  target: FileTarget,
  folder: SnapshotFolder | null,
  content: FileContent,
  replace: boolean,
): Promise<DeviceResult> {
  const bytes = bytesOf(content);
  const size = classifySize("write_bytes", bytes.length);
  if (!size.ok) return refused(size.code);
  const ready = await prepareNew(context, target, folder);
  if (!ready.ok) return ready.result;
  const resolved = ready.value;
  if (resolved.stats && !replace) return failed("target_exists");
  if (resolved.stats && !resolved.stats.isFile()) return failed("not_a_file");
  const entry = classifyNewEntry(resolved.name, "darwin", resolved.stats ? resolved.name : null);
  if (!entry.ok) return refused(entry.code);
  let temp: { path: string; ino: number };
  try {
    temp = await writeTemp(resolved.parent_real, context.newId(), bytes);
  } catch (error) {
    return failed(failureOfError(error));
  }
  try {
    await context.deps.hooks?.afterPrepare?.(resolved.real);
    const again = await recheck(context.resolve, resolved, context.command.kind);
    if (!again.ok) return resultOf(again);
    if (context.signal.aborted) return { status: "stopped" };
    context.tick("placing the file");
    const placed = await place(context, again.value, temp);
    if (!placed.ok) return placed.result;
    await syncFolder(resolved.parent_real).catch(() => {});
    const quarantined = await context.deps.mark(resolved.real).catch(() => false);
    const after = await lstat(resolved.real);
    return {
      status: "done",
      output: {
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        replaced: placed.value.replaced,
        previous_in_trash: placed.value.replaced,
        quarantined,
      },
      evidence: {
        ...(placed.value.before ? { before_version: placed.value.before } : {}),
        after_version: versionHash(after),
      },
    };
  } catch (error) {
    return failed(failureOfError(error));
  } finally {
    await discardOwn(temp.path, temp.ino);
  }
}

export async function makeFolder(
  context: OpContext,
  target: FileTarget,
  folder: SnapshotFolder | null,
): Promise<DeviceResult> {
  const ready = await prepareNew(context, target, folder);
  if (!ready.ok) return ready.result;
  const resolved = ready.value;
  if (resolved.stats) return failed("target_exists");
  const entry = classifyNewEntry(resolved.name, "darwin");
  if (!entry.ok) return refused(entry.code);
  await context.deps.hooks?.afterPrepare?.(resolved.real);
  const again = await recheck(context.resolve, resolved, context.command.kind);
  if (!again.ok) return resultOf(again);
  if (context.signal.aborted) return { status: "stopped" };
  try {
    await mkdir(resolved.real, { mode: 0o755 });
    return {
      status: "done",
      output: { created: true },
      evidence: { after_version: versionHash(await lstat(resolved.real)) },
    };
  } catch (error) {
    return failed(failureOfError(error));
  }
}
