import type { Stats } from "node:fs";
import { link, lstat, rename, unlink } from "node:fs/promises";
import type { FileItemResult, FileTarget } from "@shared/device/files.ts";
import type { DeviceResult } from "@shared/device/protocol.ts";
import { classifyNewEntry } from "@shared/local-policy/paths.ts";
import type { Grant } from "../../shared/local/files-policy.ts";
import { failureOfError } from "../../shared/local/files-policy.ts";
import { itemOf, type OpContext, sendToTrash } from "./context.ts";
import { type Resolved, recheck, resolveTarget, type Step, versionHash } from "./resolve.ts";

export type GrantOf = (target: FileTarget) => Grant;

function denied(index: number, grant: Grant & { ok: false }): FileItemResult {
  return { index, status: "refused", code: grant.code };
}

async function resolveGranted(
  context: OpContext,
  grantOf: GrantOf,
  target: FileTarget,
  intent: "mutate" | "create",
): Promise<
  | { ok: true; value: Resolved }
  | { ok: false; grant?: Grant & { ok: false }; step?: Step<unknown> & { ok: false } }
> {
  const grant = grantOf(target);
  if (!grant.ok) return { ok: false, grant };
  const step = await resolveTarget(
    context.resolve,
    target,
    grant.folder,
    intent,
    context.command.kind,
  );
  return step.ok ? step : { ok: false, step };
}

function failure(index: number, error: unknown): FileItemResult {
  return { index, status: "failed", code: failureOfError(error) };
}

function sameNode(left: Stats | null, right: Stats | null): boolean {
  return left !== null && right !== null && left.ino === right.ino && left.dev === right.dev;
}

async function dropOldName(path: string, ino: number): Promise<void> {
  const stats = await lstat(path);
  if (stats.ino === ino && stats.nlink >= 2) await unlink(path);
}

async function moveOne(
  context: OpContext,
  grantOf: GrantOf,
  index: number,
  item: { from: FileTarget; to: FileTarget },
): Promise<FileItemResult> {
  const from = await resolveGranted(context, grantOf, item.from, "mutate");
  if (!from.ok)
    return from.grant
      ? denied(index, from.grant)
      : itemOf(index, from.step as Step<unknown> & { ok: false });
  const to = await resolveGranted(context, grantOf, item.to, "create");
  if (!to.ok)
    return to.grant
      ? denied(index, to.grant)
      : itemOf(index, to.step as Step<unknown> & { ok: false });
  const source = from.value;
  const destination = to.value;
  const caseOnly = sameNode(source.stats, destination.stats);
  if (destination.stats && !caseOnly) return { index, status: "failed", code: "target_exists" };
  const entry = classifyNewEntry(destination.name, "darwin", source.name);
  if (!entry.ok) return { index, status: "refused", code: entry.code };
  await context.deps.hooks?.afterPrepare?.(source.real);
  const fromAgain = await recheck(context.resolve, source, context.command.kind);
  if (!fromAgain.ok) return itemOf(index, fromAgain);
  const toAgain = await recheck(context.resolve, destination, context.command.kind);
  if (!toAgain.ok) return itemOf(index, toAgain);
  const stats = source.stats as Stats;
  try {
    if (caseOnly || !stats.isFile()) {
      if (!caseOnly && (await lstat(destination.real).catch(() => null)))
        return { index, status: "failed", code: "target_exists" };
      await rename(source.real, destination.real);
    } else {
      await link(source.real, destination.real);
      await dropOldName(source.real, stats.ino);
    }
    return { index, status: "done", version: versionHash(await lstat(destination.real)) };
  } catch (error) {
    return failure(index, error);
  }
}

async function trashOne(
  context: OpContext,
  grantOf: GrantOf,
  index: number,
  target: FileTarget,
): Promise<FileItemResult> {
  const resolved = await resolveGranted(context, grantOf, target, "mutate");
  if (!resolved.ok)
    return resolved.grant
      ? denied(index, resolved.grant)
      : itemOf(index, resolved.step as Step<unknown> & { ok: false });
  await context.deps.hooks?.afterPrepare?.(resolved.value.real);
  const again = await recheck(context.resolve, resolved.value, context.command.kind);
  if (!again.ok) return itemOf(index, again);
  const stats = again.value.stats as Stats;
  const version = versionHash(stats);
  const trashed = await sendToTrash(context, again.value.real, stats.ino);
  return trashed
    ? { index, status: "done", version }
    : { index, status: "refused", code: "trash_unavailable" };
}

async function runBatch<T>(
  context: OpContext,
  items: readonly T[],
  one: (index: number, item: T) => Promise<FileItemResult>,
): Promise<DeviceResult> {
  const results: FileItemResult[] = [];
  for (const [index, item] of items.entries()) {
    if (context.signal.aborted) {
      results.push({ index, status: "not_run", code: "stopped" });
      continue;
    }
    try {
      context.tick(`item ${index + 1} of ${items.length}`);
      results.push(await one(index, item));
    } catch (error) {
      results.push(failure(index, error));
    }
  }
  return { status: "done", output: { items: results }, evidence: {} };
}

export function moveItems(
  context: OpContext,
  grantOf: GrantOf,
  items: readonly { from: FileTarget; to: FileTarget }[],
): Promise<DeviceResult> {
  return runBatch(context, items, (index, item) => moveOne(context, grantOf, index, item));
}

export function trashItems(
  context: OpContext,
  grantOf: GrantOf,
  items: readonly FileTarget[],
): Promise<DeviceResult> {
  return runBatch(context, items, (index, item) => trashOne(context, grantOf, index, item));
}
