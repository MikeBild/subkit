import { and, eq, inArray, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import { type Executor, ownedResources, type ScopedTx, withTenantScope } from "../../db/index.ts";
import { logger } from "../../logging/index.ts";
import {
  type DeleteOutcome,
  type OwnedDeleteDecision,
  type OwnedResourceState,
  ownedDeleteDecision,
  ownedResourceGuard,
} from "../../workflows/index.ts";

export interface OwnedResourceCorrelation {
  collection_path: string;
  tenant_id: string;
  workflow_id: string;
  workflow_version_id: string;
  environment: "dev" | "prod";
  connector_id: string;
  execution_id: string;
  step_id: string;
}

function scopeOf(correlation: OwnedResourceCorrelation, keys: readonly string[]) {
  return and(
    eq(ownedResources.tenant_id, correlation.tenant_id),
    eq(ownedResources.workflow_id, correlation.workflow_id),
    eq(ownedResources.environment, correlation.environment),
    eq(ownedResources.connector_id, correlation.connector_id),
    eq(ownedResources.collection_path, correlation.collection_path),
    inArray(ownedResources.resource_key, [...keys]),
  );
}

export async function recordCreatedResources(
  db: Executor,
  correlation: OwnedResourceCorrelation,
  keys: readonly string[],
): Promise<string[]> {
  const recorded = await withTenantScope(db, correlation.tenant_id, async (tx) => {
    const inserted = await tx
      .insert(ownedResources)
      .values(
        keys.map((resource_key) => ({
          tenant_id: correlation.tenant_id,
          workflow_id: correlation.workflow_id,
          workflow_version_id: correlation.workflow_version_id,
          environment: correlation.environment,
          connector_id: correlation.connector_id,
          collection_path: correlation.collection_path,
          resource_key,
          created_execution_id: correlation.execution_id,
          created_step_id: correlation.step_id,
        })),
      )
      .onConflictDoNothing()
      .returning({ resource_key: ownedResources.resource_key });
    if (inserted.length > 0)
      await auditAwait(
        {
          tenant_id: correlation.tenant_id,
          action: AuditAction.OWNED_RESOURCE_RECORDED,
          resource_type: "execution",
          resource_id: correlation.execution_id,
          actor_type: "system",
          result: "success",
          metadata: {
            workflow_id: correlation.workflow_id,
            step_id: correlation.step_id,
            connector_id: correlation.connector_id,
            collection_path: correlation.collection_path,
            environment: correlation.environment,
            recorded: inserted.length,
          },
        },
        tx,
      );
    return inserted.map((row) => row.resource_key);
  });
  logger.info({
    module: "execution",
    action: "owned_resource.recorded",
    msg: "created ids recorded in the workflow's ownership ledger",
    execution_id: correlation.execution_id,
    step_id: correlation.step_id,
    recorded: recorded.length,
    already_recorded: keys.length - recorded.length,
  });
  return recorded;
}

async function ledgerRows(
  tx: ScopedTx,
  correlation: OwnedResourceCorrelation,
  keys: readonly string[],
) {
  return tx
    .select({
      resource_key: ownedResources.resource_key,
      state: ownedResources.state,
      deleted_execution_id: ownedResources.deleted_execution_id,
      deleted_step_id: ownedResources.deleted_step_id,
      deleted_result: ownedResources.deleted_result,
    })
    .from(ownedResources)
    .where(scopeOf(correlation, keys))
    .for("update");
}

export type OwnedDeleteReplay = {
  resource_key: string;
  execution_id: string | null;
  step_id: string | null;
};

export type OwnedDeleteClaimDecision =
  | Exclude<OwnedDeleteDecision, { replay: true }>
  | {
      allow: true;
      replay: true;
      replayed_from: OwnedDeleteReplay[];
      replayed_result: { execution_id: string | null; stored: unknown };
    };

export async function claimOwnedDelete(
  db: Executor,
  correlation: OwnedResourceCorrelation,
  request: { method: string; destructive: boolean; resource_keys: readonly string[] },
): Promise<OwnedDeleteClaimDecision> {
  const decision = await withTenantScope(
    db,
    correlation.tenant_id,
    async (tx): Promise<OwnedDeleteClaimDecision> => {
      const rows = await ledgerRows(tx, correlation, request.resource_keys);
      const ledger = new Map<string, OwnedResourceState>(
        rows.map((row) => [row.resource_key, row.state]),
      );
      const verdict = ownedDeleteDecision({ ...request, ledger });
      if (!verdict.allow) return verdict;
      if (verdict.replay) {
        const replayed_from = rows.map((row) => ({
          resource_key: row.resource_key,
          execution_id: row.deleted_execution_id,
          step_id: row.deleted_step_id,
        }));
        await auditAwait(
          {
            tenant_id: correlation.tenant_id,
            action: AuditAction.OWNED_RESOURCE_DELETE_REPLAYED,
            resource_type: "execution",
            resource_id: correlation.execution_id,
            actor_type: "system",
            result: "success",
            metadata: {
              workflow_id: correlation.workflow_id,
              step_id: correlation.step_id,
              connector_id: correlation.connector_id,
              collection_path: correlation.collection_path,
              replayed_from,
            },
          },
          tx,
        );
        const [first] = rows;
        return {
          ...verdict,
          replayed_from,
          replayed_result: {
            execution_id: first?.deleted_execution_id ?? null,
            stored: first?.deleted_result ?? null,
          },
        };
      }
      const guard = ownedResourceGuard("delete_reserved");
      await tx
        .update(ownedResources)
        .set({
          state: guard.to,
          deleted_execution_id: correlation.execution_id,
          deleted_step_id: correlation.step_id,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(scopeOf(correlation, request.resource_keys), eq(ownedResources.state, guard.from)),
        );
      return verdict;
    },
  );
  logger[decision.allow ? "info" : "warn"]({
    module: "execution",
    action: !decision.allow
      ? "owned_resource.delete_denied"
      : decision.replay
        ? "owned_resource.delete_replayed"
        : "owned_resource.delete_reserved",
    msg: !decision.allow
      ? "removal refused by the ownership ledger; nothing was sent"
      : decision.replay
        ? "removal already confirmed earlier; the stored outcome is replayed and nothing was sent"
        : "removal of ids this workflow created reserved before sending",
    execution_id: correlation.execution_id,
    step_id: correlation.step_id,
    ...(decision.allow ? {} : { code: decision.code }),
    ...(decision.allow && decision.replay ? { replayed_from: decision.replayed_from } : {}),
  });
  return decision;
}

export async function settleOwnedDelete(
  db: Executor,
  correlation: OwnedResourceCorrelation,
  keys: readonly string[],
  outcome: DeleteOutcome,
  stored: unknown = null,
): Promise<number> {
  const guard = ownedResourceGuard(outcome);
  const settled = await withTenantScope(db, correlation.tenant_id, async (tx) => {
    const updated = await tx
      .update(ownedResources)
      .set({
        state: guard.to,
        ...(guard.to === "owned" ? { deleted_execution_id: null, deleted_step_id: null } : {}),
        ...(guard.to === "deleted" ? { deleted_result: stored } : {}),
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          scopeOf(correlation, keys),
          eq(ownedResources.state, guard.from),
          eq(ownedResources.deleted_execution_id, correlation.execution_id),
          eq(ownedResources.deleted_step_id, correlation.step_id),
        ),
      )
      .returning({ resource_key: ownedResources.resource_key });
    if (updated.length > 0)
      await auditAwait(
        {
          tenant_id: correlation.tenant_id,
          action: AuditAction.OWNED_RESOURCE_DELETE_SETTLED,
          resource_type: "execution",
          resource_id: correlation.execution_id,
          actor_type: "system",
          result: guard.to === "deleted" ? "success" : "error",
          metadata: {
            workflow_id: correlation.workflow_id,
            step_id: correlation.step_id,
            connector_id: correlation.connector_id,
            collection_path: correlation.collection_path,
            state: guard.to,
            settled: updated.length,
          },
        },
        tx,
      );
    return updated.length;
  });
  logger[guard.to === "delete_unknown" ? "warn" : "info"]({
    module: "execution",
    action: "owned_resource.delete_settled",
    msg: "removal of ids this workflow created settled",
    execution_id: correlation.execution_id,
    step_id: correlation.step_id,
    state: guard.to,
    settled,
  });
  return settled;
}
