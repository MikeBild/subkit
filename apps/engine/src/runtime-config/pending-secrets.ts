import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { SYSTEM_TENANT_ID } from "../audit/types.ts";
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
  bindings: Array<{ path: string; outcome: "rebound" | "failed"; detail: string | null }>;
}

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
      const activated = await activateRuntimeRevision(db, saved.saved_revision, {
        tenant_id: SYSTEM_TENANT_ID,
        actor_type: args.created_by ? "user" : "system",
        actor_id: args.created_by,
        source: "api",
      });
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
