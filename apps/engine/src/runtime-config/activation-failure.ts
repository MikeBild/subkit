import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { runtimeConfigRevisions, runtimeConfigState } from "../db/schema/index.ts";
import { CONFIG_STATE_KEY } from "./contracts.ts";
import { revisionChangesOnlyTenant } from "./document.ts";
import { runtimeStateColumns } from "./state-columns.ts";

export async function failRuntimeActivation(
  db: Db,
  revision: number,
  reason: string,
  restrictedTenant?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // tenant-filter:exempt — failure cleanup serializes the product-global revision pointer.
    const [state] = await tx
      .select(runtimeStateColumns)
      .from(runtimeConfigState)
      .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
      .for("update");
    if (state?.active_revision === revision) return;
    await tx
      .update(runtimeConfigRevisions)
      .set({ status: "failed", failure_reason: reason })
      .where(eq(runtimeConfigRevisions.revision, revision));
    if (!restrictedTenant || !state?.active_revision || state.desired_revision !== revision) {
      return;
    }
    // tenant-filter:exempt — revision documents are product-global; the tenant-only diff is checked below.
    const [active] = await tx
      .select()
      .from(runtimeConfigRevisions)
      .where(eq(runtimeConfigRevisions.revision, state.active_revision));
    // tenant-filter:exempt — revision documents are product-global; the tenant-only diff is checked below.
    const [candidate] = await tx
      .select()
      .from(runtimeConfigRevisions)
      .where(eq(runtimeConfigRevisions.revision, revision));
    if (
      active &&
      candidate &&
      revisionChangesOnlyTenant(active.document, candidate.document, restrictedTenant)
    ) {
      await tx
        .update(runtimeConfigState)
        .set({ desired_revision: state.active_revision, updated_at: new Date() })
        .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY));
    }
  });
}
