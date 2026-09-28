// Prepared secret versions — "Freigaben statt Eingaben".
//
// A version can be WRITTEN without becoming current: by `engine --vault-set
// … --pending` from the host, or by anything else that holds a value a
// person has not yet looked at. Such a version waits in the Cockpit as a
// "Vorbereitete Änderung" with two buttons. "Freigeben" makes it the current
// version and re-points the bindings it was prepared for; "Ablehnen" revokes
// it. Nothing about the value is ever shown — only its name, its version,
// who prepared it and since when.
//
// Approval is two steps on purpose. Clearing `pending_since` is a row update
// inside one transaction; re-pinning goes through the same save-then-activate
// path the settings API uses, because that path is what coordinates live
// replicas. A binding that fails to re-pin does not un-approve the version:
// the value is good, the pointer is what still needs a hand, and the line
// the route returns says so.

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { runtimeSecretVersions } from "../db/schema/index.ts";
import { invalidateTenantState } from "../operator/index.ts";
import { RuntimeConfigNotFoundError } from "./contracts.ts";
import {
  activateRuntimeRevision,
  getRuntimeConfigState,
  saveRuntimeConfigPatch,
  secretReference,
} from "./service.ts";

export interface PendingSecretVersion {
  name: string;
  version: number;
  reference: string;
  prepared_by: string;
  pending_since: Date;
  bindings: string[];
}

export async function listPendingSecretVersions(db: Db): Promise<PendingSecretVersion[]> {
  // tenant-filter:exempt — the secret registry is product-global operator state.
  const rows = await db
    .select({
      name: runtimeSecretVersions.name,
      version: runtimeSecretVersions.version,
      prepared_by: runtimeSecretVersions.prepared_by,
      pending_since: runtimeSecretVersions.pending_since,
      pending_bindings: runtimeSecretVersions.pending_bindings,
    })
    .from(runtimeSecretVersions)
    .where(
      and(isNotNull(runtimeSecretVersions.pending_since), isNull(runtimeSecretVersions.revoked_at)),
    )
    .orderBy(runtimeSecretVersions.pending_since, runtimeSecretVersions.name);
  return rows.flatMap((row) =>
    row.pending_since
      ? [
          {
            name: row.name,
            version: row.version,
            reference: secretReference(row.name, row.version),
            prepared_by: row.prepared_by ?? "",
            pending_since: row.pending_since,
            bindings: row.pending_bindings ?? [],
          },
        ]
      : [],
  );
}

export interface ApprovalOutcome {
  name: string;
  version: number;
  /** Every binding the version was prepared for, with what happened to it. */
  bindings: Array<{ path: string; outcome: "rebound" | "failed"; detail: string | null }>;
}

/**
 * Make a prepared version current and re-point its bindings.
 *
 * Clearing the flag comes first and commits on its own: from that moment the
 * version reads like any other and `--vault-check` sees it. The re-pins then
 * run one at a time through the settings revision path. Global scope only —
 * the host CLI that prepared it has no tenant either.
 */
export async function approvePendingSecretVersion(
  db: Db,
  args: { name: string; version: number; created_by: string | null },
): Promise<ApprovalOutcome> {
  const [approved] = await db
    .update(runtimeSecretVersions)
    .set({ pending_since: null })
    .where(
      and(
        eq(runtimeSecretVersions.name, args.name),
        eq(runtimeSecretVersions.version, args.version),
        isNotNull(runtimeSecretVersions.pending_since),
        isNull(runtimeSecretVersions.revoked_at),
      ),
    )
    .returning({ pending_bindings: runtimeSecretVersions.pending_bindings });
  if (!approved) {
    throw new RuntimeConfigNotFoundError(
      `no prepared secret version to approve: ${args.name}/${args.version}`,
    );
  }
  // Installation-wide: a prepared version waits on every tenant's list, and it
  // stops waiting the moment it is approved — before its bindings re-pin.
  invalidateTenantState();
  const bindings: ApprovalOutcome["bindings"] = [];
  for (const path of approved.pending_bindings ?? []) {
    try {
      const state = await getRuntimeConfigState(db);
      const saved = await saveRuntimeConfigPatch(db, {
        expected_revision: state.saved_revision,
        changes: { [path]: secretReference(args.name, args.version) },
        scope: "global",
        created_by: args.created_by,
      });
      const activated = await activateRuntimeRevision(db, saved.saved_revision);
      bindings.push({
        path,
        outcome: activated.activation_status === "failed" ? "failed" : "rebound",
        detail:
          activated.activation_status === "active" ? null : String(activated.activation_status),
      });
    } catch (error) {
      bindings.push({
        path,
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { name: args.name, version: args.version, bindings };
}

/** Revoke a prepared version. It was never current, so nothing can reference it. */
export async function rejectPendingSecretVersion(
  db: Db,
  args: { name: string; version: number },
): Promise<{ name: string; version: number; revoked_at: Date }> {
  const revokedAt = new Date();
  const [rejected] = await db
    .update(runtimeSecretVersions)
    .set({ revoked_at: revokedAt, pending_since: null })
    .where(
      and(
        eq(runtimeSecretVersions.name, args.name),
        eq(runtimeSecretVersions.version, args.version),
        isNotNull(runtimeSecretVersions.pending_since),
        isNull(runtimeSecretVersions.revoked_at),
      ),
    )
    .returning({ revoked_at: runtimeSecretVersions.revoked_at });
  if (!rejected?.revoked_at) {
    throw new RuntimeConfigNotFoundError(
      `no prepared secret version to reject: ${args.name}/${args.version}`,
    );
  }
  invalidateTenantState();
  return { name: args.name, version: args.version, revoked_at: rejected.revoked_at };
}
