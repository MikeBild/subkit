import { isAuthorityRefusalCode } from "@shared/authority-refusal.ts";
import type { PgBoss } from "pg-boss";
import { AuditAction, audit } from "../../audit/index.ts";
import type { Db, Executor } from "../../db/index.ts";
import { enqueueExecutionRun } from "../../devices/index.ts";
import { errorFields, logger } from "../../logging/index.ts";
import { admitWebhookExecution, sameWebhookEvent, type WebhookBinding } from "./admission.ts";
import { decideRecordedExecution } from "./core/held-delivery.ts";
import { markSeenIfNew } from "./dedup.ts";
import {
  type ClaimedHeldDelivery,
  claimHeldDelivery,
  expireHeldDeliveries,
  finishHeldClaim,
  type HeldArrival,
  type HoldInput,
  heldDeliveriesDueForResume,
  heldDeliveryIds,
  heldPayload,
  readRecordedExecution,
  readReplayTarget,
  reclaimLapsedHeldClaims,
  recordHeldExecution,
  settleHeldDelivery,
  storeHeldDelivery,
  workflowsWithReleasedHolds,
} from "./persistence/held-deliveries.ts";

export type { HeldArrival } from "./persistence/held-deliveries.ts";

const PERMANENT_REFUSALS = new Set([
  "inactive",
  "workflow_inactive",
  "execution_boundary_mismatch",
  "workflow_version_not_active",
  "input_schema_violation",
  "execution_missing",
  "execution_aborted",
]);

const LOG_MODULE = "webhooks.inbound";

export async function holdSignedDelivery(
  db: Db,
  input: Omit<HoldInput, "hook" | "same_event"> & { hook: WebhookBinding },
): Promise<HeldArrival> {
  const arrival = await storeHeldDelivery(db, {
    ...input,
    same_event: (stored) => sameWebhookEvent(input.hook, stored, input.payload),
  });
  logger.info({
    module: LOG_MODULE,
    action: "inbound.held",
    msg: "signed delivery arrived while its workflow waits for approval",
    tenant_id: input.hook.tenant_id,
    inbound_id: input.hook.id,
    webhook_id: input.delivery.id,
    event_type: input.delivery.type,
    outcome: arrival.status,
    duplicate: arrival.status === "held" && arrival.duplicate,
  });
  if (arrival.status === "mismatch")
    audit(
      {
        tenant_id: input.hook.tenant_id,
        action: AuditAction.WEBHOOK_INBOUND_DENIED,
        resource_type: "webhook_inbound",
        resource_id: input.hook.id,
        result: "denied",
        reason: "execution_boundary_mismatch",
        metadata: { event_id: input.delivery.id, held_for_approval: true },
      },
      db,
    );
  return arrival;
}

class ReplayRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function refusalCode(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "";
}

export type ReplayOutcome = "skipped" | "replayed" | "held" | "failed";

type HeldReplayTarget = Awaited<ReturnType<typeof readReplayTarget>>;

async function resumeRecordedExecution(
  tx: Executor,
  held: ClaimedHeldDelivery,
  binding: HeldReplayTarget["binding"],
) {
  const recorded = await readRecordedExecution(tx, held);
  if (!recorded) return null;
  const decision = decideRecordedExecution(recorded.execution?.status ?? null);
  if (decision.action === "fail") throw new ReplayRefusal(decision.code);
  return {
    held,
    binding,
    workflow_id: recorded.execution?.workflow_id ?? held.workflow_id,
    admitted: {
      execution_id: recorded.execution_id,
      enqueue: decision.action === "enqueue",
      deduplicated: true,
    },
  };
}

async function claimAndAdmit(db: Db, tenant_id: string, id: string) {
  return db.transaction(async (tx) => {
    const held = await claimHeldDelivery(tx, tenant_id, id);
    if (!held) return null;
    const { binding, workflow } = await readReplayTarget(tx, held);
    const resumed = await resumeRecordedExecution(tx, held, binding);
    if (resumed) return resumed;
    if (!binding?.active) throw new ReplayRefusal("inactive");
    if (!workflow?.current_version_id || workflow.deleted_at || workflow.lifecycle === "archived")
      throw new ReplayRefusal("workflow_inactive");
    const admitted = await admitWebhookExecution(
      tx,
      binding,
      workflow.current_version_id,
      heldPayload(held),
    );
    await recordHeldExecution(tx, held, admitted.execution_id);
    return {
      held,
      binding,
      workflow_id: binding.workflow_id,
      admitted: {
        execution_id: admitted.execution_id,
        enqueue: admitted.status === "queued",
        deduplicated: admitted.replayed,
      },
    };
  });
}

async function settleRefusedReplay(
  db: Db,
  tenant_id: string,
  id: string,
  error: unknown,
): Promise<ReplayOutcome> {
  const code = refusalCode(error);
  if (!PERMANENT_REFUSALS.has(code)) {
    logger.warn({
      module: LOG_MODULE,
      action: "inbound.held_replay_deferred",
      msg: "a held delivery could not be replayed yet and stays held",
      tenant_id,
      held_delivery_id: id,
      reason: isAuthorityRefusalCode(code) ? code : "replay_error",
      ...(isAuthorityRefusalCode(code) ? {} : errorFields(error)),
    });
    return "held";
  }
  const failed = await settleHeldDelivery(
    db,
    tenant_id,
    id,
    { kind: "refused", code },
    { outcome_code: code },
  );
  if (!failed) return "skipped";
  audit(
    {
      tenant_id,
      action: AuditAction.WEBHOOK_INBOUND_DENIED,
      resource_type: "webhook_inbound",
      resource_id: failed.inbound_id,
      result: "denied",
      reason: code,
      metadata: { event_id: failed.delivery_id, replayed_from_hold: true },
    },
    db,
  );
  logger.warn({
    module: LOG_MODULE,
    action: "inbound.held_replay_failed",
    msg: "a held delivery was refused on replay and will not run",
    tenant_id,
    inbound_id: failed.inbound_id,
    webhook_id: failed.delivery_id,
    reason: code,
  });
  return "failed";
}

export async function replayHeldDelivery(
  db: Db,
  boss: PgBoss,
  tenant_id: string,
  id: string,
): Promise<ReplayOutcome> {
  let claimed: Awaited<ReturnType<typeof claimAndAdmit>>;
  try {
    claimed = await claimAndAdmit(db, tenant_id, id);
  } catch (error) {
    return settleRefusedReplay(db, tenant_id, id, error);
  }
  if (!claimed) return "skipped";
  const { held, binding, workflow_id, admitted } = claimed;
  try {
    if (admitted.enqueue)
      await enqueueExecutionRun(db, boss, {
        tenant_id,
        workflow_id,
        execution_id: admitted.execution_id,
        request_source: "webhook",
        execution_mode: "prod",
      });
  } catch (error) {
    await finishHeldClaim(db, held, { kind: "enqueue_failed" });
    logger.warn({
      module: LOG_MODULE,
      action: "inbound.held_replay_deferred",
      msg: "a held delivery could not reach the run queue and stays held for the next replay",
      tenant_id,
      held_delivery_id: id,
      execution_id: admitted.execution_id,
      reason: "enqueue_failed",
      ...errorFields(error),
    });
    return "held";
  }
  if (!(await finishHeldClaim(db, held, { kind: "enqueued" }))) {
    logger.info({
      module: LOG_MODULE,
      action: "inbound.held_replay_superseded",
      msg: "a held delivery replay lost its lapsed claim to a newer replay",
      tenant_id,
      held_delivery_id: id,
      execution_id: admitted.execution_id,
    });
    return "skipped";
  }
  if (binding)
    await markSeenIfNew(db, {
      tenant_id,
      webhook_id: binding.id,
      standard_webhook_id: held.delivery_id,
    });
  audit(
    {
      tenant_id,
      action:
        binding?.origin === "trigger"
          ? AuditAction.WEBHOOK_TRIGGER_FIRED
          : AuditAction.WEBHOOK_INBOUND_RECEIVED,
      resource_type: "webhook_inbound",
      resource_id: held.inbound_id,
      result: "success",
      metadata: {
        event_id: held.delivery_id,
        event_type: held.event_type,
        execution_id: admitted.execution_id,
        replayed_from_hold: true,
      },
    },
    db,
  );
  logger.info({
    module: LOG_MODULE,
    action: "inbound.held_replayed",
    msg: "a held delivery was replayed after approval",
    tenant_id,
    inbound_id: held.inbound_id,
    webhook_id: held.delivery_id,
    execution_id: admitted.execution_id,
    deduplicated: admitted.deduplicated,
  });
  return "replayed";
}

export async function replayHeldDeliveries(
  db: Db,
  boss: PgBoss,
  scope: { tenant_id: string; workflow_id: string },
): Promise<Record<ReplayOutcome, number>> {
  const tally: Record<ReplayOutcome, number> = { skipped: 0, replayed: 0, held: 0, failed: 0 };
  for (const id of await heldDeliveryIds(db, scope)) {
    const outcome = await replayHeldDelivery(db, boss, scope.tenant_id, id);
    tally[outcome] += 1;
    if (outcome === "held") break;
  }
  return tally;
}

export async function replayHeldDeliveriesSafely(
  db: Db,
  boss: () => PgBoss,
  scope: { tenant_id: string; workflow_id: string },
): Promise<void> {
  try {
    await replayHeldDeliveries(db, boss(), scope);
  } catch (error) {
    logger.warn({
      module: LOG_MODULE,
      action: "inbound.held_replay_deferred",
      msg: "held deliveries were not replayed now; the scheduler sweep retries them",
      tenant_id: scope.tenant_id,
      workflow_id: scope.workflow_id,
      ...errorFields(error),
    });
  }
}

export async function settleExpiredHeldDeliveries(db: Executor): Promise<number> {
  const expired = await expireHeldDeliveries(db);
  for (const row of expired)
    logger.info({
      module: LOG_MODULE,
      action: "inbound.held_expired",
      msg: "a held delivery expired before its workflow was approved",
      tenant_id: row.tenant_id,
      inbound_id: row.inbound_id,
      webhook_id: row.delivery_id,
    });
  return expired.length;
}

export async function reclaimLapsedHeldReplays(db: Executor): Promise<number> {
  const lapsed = await reclaimLapsedHeldClaims(db);
  for (const row of lapsed)
    logger.warn({
      module: LOG_MODULE,
      action: "inbound.held_replay_reclaimed",
      msg: "a held delivery replay claim lapsed before its run was queued and returns to held",
      tenant_id: row.tenant_id,
      inbound_id: row.inbound_id,
      webhook_id: row.delivery_id,
    });
  return lapsed.length;
}

export async function resumeAdmittedHeldDeliveries(db: Db, boss: PgBoss): Promise<number> {
  let resumed = 0;
  for (const row of await heldDeliveriesDueForResume(db)) {
    const outcome = await replayHeldDelivery(db, boss, row.tenant_id, row.id);
    if (outcome === "replayed") resumed += 1;
  }
  return resumed;
}

export async function runHeldDeliverySweep(db: Db, boss: PgBoss): Promise<void> {
  await reclaimLapsedHeldReplays(db);
  await resumeAdmittedHeldDeliveries(db, boss);
  await settleExpiredHeldDeliveries(db);
  for (const scope of await workflowsWithReleasedHolds(db))
    await replayHeldDeliveriesSafely(db, () => boss, scope);
}
