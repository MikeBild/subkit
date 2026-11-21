import type { DeviceResult } from "@shared/device/protocol.ts";
import type { ComputerSnapshot } from "../../shared/local/computer-allowances.ts";
import {
  listAppsArgs,
  listWindowsArgs,
  snapshotArgs,
} from "../../shared/local/computer-commands.ts";
import {
  type Envelope,
  errorVerdict,
  type InventoryWindow,
  inventoryOf,
  snapshotData,
} from "../../shared/local/computer-envelope.ts";
import { type RawNode, RawNodeSchema, stateHash } from "../../shared/local/computer-tree.ts";
import { HELPER_CALL_LIMIT_MS, type HelperCall, type HelperRunner } from "./helper.ts";
import { refused } from "./results.ts";

export const KNOWN_SNAPSHOTS_MAX = 16;

export interface KnownSnapshot {
  readonly snapshot_id: string;
  readonly window_id: string;
  readonly bundle_id: string;
  readonly hash: string;
  readonly complete: boolean;
  readonly tree: RawNode;
}

export type Step<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly result: DeviceResult };

export function fail(result: DeviceResult): Step<never> {
  return { ok: false, result };
}

export interface CallContext {
  readonly helper: HelperRunner;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly now: () => number;
}

export async function call(
  context: CallContext,
  args: readonly string[],
  stdin?: string,
): Promise<Step<Envelope>> {
  const timeoutMs = Math.min(HELPER_CALL_LIMIT_MS, context.deadline - context.now());
  if (context.signal.aborted) return fail({ status: "stopped" });
  if (timeoutMs <= 0) return fail(refused("deadline_passed"));
  const request: HelperCall =
    stdin === undefined ? { args, timeoutMs } : { args, stdin, timeoutMs };
  const outcome = await context.helper.run(request, context.signal);
  if (outcome.kind === "stopped") return fail({ status: "stopped" });
  if (outcome.kind === "timeout") {
    return fail({
      status: "failed",
      code: "helper_timeout",
      detail: "The app did not answer in time.",
    });
  }
  if (outcome.kind === "broken") {
    return fail({ status: "failed", code: "helper_broken", detail: outcome.detail });
  }
  return { ok: true, value: outcome.envelope };
}

export function verdictOf(envelope: Envelope): DeviceResult {
  const verdict = errorVerdict(envelope.error ?? { code: "INTERNAL" }, envelope.command);
  if (verdict.kind === "refused") return refused(verdict.code);
  return {
    status: "failed",
    code: verdict.code,
    detail:
      verdict.code === "delivery_uncertain"
        ? "The input may have reached the app. SubKit does not repeat it."
        : "The app refused the action. Nothing was sent.",
  };
}

export async function data(
  context: CallContext,
  args: readonly string[],
  stdin?: string,
): Promise<Step<unknown>> {
  const step = await call(context, args, stdin);
  if (!step.ok) return step;
  return step.value.ok ? { ok: true, value: step.value.data } : fail(verdictOf(step.value));
}

export async function inventory(context: CallContext): Promise<Step<InventoryWindow[]>> {
  const windows = await data(context, listWindowsArgs());
  if (!windows.ok) return windows;
  const apps = await data(context, listAppsArgs());
  if (!apps.ok) return apps;
  const joined = inventoryOf(windows.value, apps.value);
  return joined
    ? { ok: true, value: joined }
    : fail({
        status: "failed",
        code: "helper_shape",
        detail: "The window list could not be read.",
      });
}

export class SnapshotMemory {
  private readonly entries = new Map<string, KnownSnapshot>();

  remember(entry: KnownSnapshot): void {
    this.entries.delete(entry.snapshot_id);
    this.entries.set(entry.snapshot_id, entry);
    while (this.entries.size > KNOWN_SNAPSHOTS_MAX) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  forRef(ref: string): KnownSnapshot | null {
    const id = ref.slice(1, ref.indexOf(":"));
    return this.entries.get(id) ?? null;
  }

  clear(): void {
    this.entries.clear();
  }
}

export async function snapshot(
  context: CallContext,
  windowId: string,
  bundleId: string,
): Promise<Step<KnownSnapshot>> {
  const step = await data(context, snapshotArgs(windowId));
  if (!step.ok) return step;
  const parsed = snapshotData(step.value);
  const tree = parsed ? RawNodeSchema.safeParse(parsed.tree) : null;
  if (!parsed || !tree?.success) {
    return fail({
      status: "failed",
      code: "helper_shape",
      detail: "The window could not be read.",
    });
  }
  return {
    ok: true,
    value: {
      snapshot_id: parsed.snapshot_id,
      window_id: windowId,
      bundle_id: bundleId,
      hash: stateHash(tree.data),
      complete: parsed.complete,
      tree: tree.data,
    },
  };
}

export function liveSnapshot(snapshot: ComputerSnapshot): boolean {
  return snapshot.enabled && snapshot.helper !== null;
}
