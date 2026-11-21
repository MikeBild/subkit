import { secretReference } from "@shared/vault-handle.ts";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  runtimeConfigRevisions,
  runtimeConfigState,
  runtimeSecretVersions,
} from "../db/schema/index.ts";
import { CONFIG_STATE_KEY } from "./contracts.ts";
import { runtimeStateColumns } from "./state-columns.ts";

export async function removeUnreferencedSecretVersion(
  db: Db,
  args: { name: string; version: number },
): Promise<boolean> {
  const quoted = JSON.stringify(secretReference(args.name, args.version));
  return db.transaction(async (tx) => {
    // tenant-filter:exempt — removal checks the product-global revision pointers.
    const [state] = await tx
      .select(runtimeStateColumns)
      .from(runtimeConfigState)
      .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
      .for("update");
    const revisions = [state?.active_revision, state?.desired_revision].filter(
      (revision): revision is number => revision !== null && revision !== undefined,
    );
    if (revisions.length > 0) {
      // tenant-filter:exempt — referenced revisions are product-global operator state.
      const documents = await tx
        .select({ document: runtimeConfigRevisions.document })
        .from(runtimeConfigRevisions)
        .where(inArray(runtimeConfigRevisions.revision, [...new Set(revisions)]));
      if (documents.some((row) => JSON.stringify(row.document).includes(quoted))) return false;
    }
    // tenant-filter:exempt — the exact secret name and version address one row of the product-global registry.
    const removed = await tx
      .delete(runtimeSecretVersions)
      .where(
        and(
          eq(runtimeSecretVersions.name, args.name),
          eq(runtimeSecretVersions.version, args.version),
        ),
      )
      .returning({ version: runtimeSecretVersions.version });
    return removed.length > 0;
  });
}
