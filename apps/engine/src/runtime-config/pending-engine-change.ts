import { eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { runtimeConfigRevisions, runtimeConfigState } from "../db/schema/index.ts";
import { CONFIG_STATE_KEY, RuntimeConfigPendingError } from "./contracts.ts";
import { revisionChangesOneTenantOnly } from "./document.ts";
import { runtimeStateColumns } from "./state-columns.ts";

export type PendingRuntimeChange = "none" | "workspace" | "engine";

export async function pendingRuntimeChange(db: Executor): Promise<PendingRuntimeChange> {
  // tenant-filter:exempt — the canonical active/desired pointer is product-global.
  const [state] = await db
    .select(runtimeStateColumns)
    .from(runtimeConfigState)
    .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
    .limit(1);
  if (!state?.active_revision) return "none";
  const desired = state.desired_revision ?? state.active_revision;
  if (desired === state.active_revision) return "none";
  // tenant-filter:exempt — revision documents are product-global; only the shape of their difference is read.
  const revisions = await db
    .select({
      revision: runtimeConfigRevisions.revision,
      document: runtimeConfigRevisions.document,
    })
    .from(runtimeConfigRevisions)
    .where(inArray(runtimeConfigRevisions.revision, [state.active_revision, desired]));
  const active = revisions.find((row) => row.revision === state.active_revision);
  const pending = revisions.find((row) => row.revision === desired);
  if (!active || !pending) return "engine";
  return revisionChangesOneTenantOnly(active.document, pending.document) ? "workspace" : "engine";
}

export async function assertNoPendingEngineChange(db: Executor): Promise<void> {
  if ((await pendingRuntimeChange(db)) !== "none") throw new RuntimeConfigPendingError();
}

const WORKSPACE_CHANGE_WAITS_MS = [100, 200, 400, 800, 1_500, 2_000];

export async function waitOutWorkspaceChange(
  db: Executor,
  waitsMs: readonly number[] = WORKSPACE_CHANGE_WAITS_MS,
): Promise<void> {
  for (const wait of [...waitsMs, null]) {
    const pending = await pendingRuntimeChange(db);
    if (pending === "none") return;
    if (pending === "engine" || wait === null) throw new RuntimeConfigPendingError();
    await Bun.sleep(wait);
  }
}
