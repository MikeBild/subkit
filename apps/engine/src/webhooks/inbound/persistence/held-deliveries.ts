import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lte, notInArray, sql } from "drizzle-orm";
import {
  type Executor,
  executions,
  webhookHeldDeliveries,
  webhooksInbound,
  withSystemScope,
  withTenantScope,
  workflows,
  workflowVersions,
} from "../../../db/index.ts";
import { protectExecutionPayload, recoverExecutionPayload } from "../../../execution/index.ts";
import {
  decideHeldArrival,
  HELD_DELIVERY_LIMITS,
  type HeldDeliveryEvent,
  nextHeldDeliveryState,
  OPEN_HELD_DELIVERY_STATES,
} from "../core/held-delivery.ts";

const PAYLOAD_SLOT = "held_delivery";

const RETENTION = sql`make_interval(hours => ${HELD_DELIVERY_LIMITS.ttl_hours})`;

const CLAIM_LEASE = sql`make_interval(secs => ${HELD_DELIVERY_LIMITS.claim_lease_seconds})`;

const OPEN_STATES = [...OPEN_HELD_DELIVERY_STATES];

const CLAIMABLE = sql`(${webhookHeldDeliveries.expires_at} > clock_timestamp() OR ${webhookHeldDeliveries.execution_id} IS NOT NULL)`;

export type HeldDeliveryRow = typeof webhookHeldDeliveries.$inferSelect;

export type ClaimedHeldDelivery = HeldDeliveryRow & { claim_token: string };

export interface HoldInput {
  hook: { tenant_id: string; id: string; workflow_id: string };
  version_id: string;
  delivery: { id: string; type: string };
  payload: unknown;
  body_bytes: number;
  reason_code: string;
  same_event: (stored_payload: unknown) => boolean;
}

export type HeldArrival =
  | { status: "held"; duplicate: boolean }
  | { status: "too_large" }
  | { status: "over_capacity" }
  | { status: "mismatch" }
  | { status: "settled" };

async function sensitiveVersion(db: Executor, tenant_id: string, version_id: string) {
  const [version] = await db
    .select({ privacy: sql<string | null>`${workflowVersions.dag} ->> 'execution_privacy'` })
    .from(workflowVersions)
    .where(and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.id, version_id)))
    .limit(1);
  return version?.privacy === "sensitive";
}

export async function storeHeldDelivery(db: Executor, input: HoldInput): Promise<HeldArrival> {
  const { hook, delivery } = input;
  const sensitive = await sensitiveVersion(db, hook.tenant_id, input.version_id);
  return withTenantScope(db, hook.tenant_id, async (tx): Promise<HeldArrival> => {
    await tx
      .select({ id: webhooksInbound.id })
      .from(webhooksInbound)
      .where(and(eq(webhooksInbound.tenant_id, hook.tenant_id), eq(webhooksInbound.id, hook.id)))
      .for("update");
    const [existing] = await tx
      .select({
        id: webhookHeldDeliveries.id,
        state: webhookHeldDeliveries.state,
        payload: webhookHeldDeliveries.payload,
      })
      .from(webhookHeldDeliveries)
      .where(
        and(
          eq(webhookHeldDeliveries.tenant_id, hook.tenant_id),
          eq(webhookHeldDeliveries.inbound_id, hook.id),
          eq(webhookHeldDeliveries.delivery_id, delivery.id),
        ),
      );
    const [counted] = await tx
      .select({ held: sql<number>`count(*)::int` })
      .from(webhookHeldDeliveries)
      .where(
        and(
          eq(webhookHeldDeliveries.tenant_id, hook.tenant_id),
          eq(webhookHeldDeliveries.inbound_id, hook.id),
          inArray(webhookHeldDeliveries.state, OPEN_STATES),
        ),
      );
    const decision = decideHeldArrival({
      existing_state: existing?.state ?? null,
      same_event:
        !existing ||
        input.same_event(
          recoverExecutionPayload(existing.payload, hook.tenant_id, existing.id, PAYLOAD_SLOT),
        ),
      body_bytes: input.body_bytes,
      held_count: counted?.held ?? 0,
      delivery_id_length: delivery.id.length,
    });
    if (decision === "duplicate") return { status: "held", duplicate: true };
    if (decision !== "store") return { status: decision };
    const id = randomUUID();
    await tx.insert(webhookHeldDeliveries).values({
      id,
      tenant_id: hook.tenant_id,
      inbound_id: hook.id,
      workflow_id: hook.workflow_id,
      delivery_id: delivery.id,
      event_type: delivery.type,
      payload: sensitive
        ? protectExecutionPayload(input.payload, hook.tenant_id, id, PAYLOAD_SLOT)
        : input.payload,
      body_bytes: input.body_bytes,
      reason_code: input.reason_code,
      expires_at: sql`clock_timestamp() + ${RETENTION}`,
    });
    return { status: "held", duplicate: false };
  });
}

export async function readOpenHeldPayload(
  db: Executor,
  tenant_id: string,
  inbound_id: string,
  delivery_id: string,
): Promise<unknown> {
  const [row] = await withTenantScope(db, tenant_id, (tx) =>
    tx
      .select({ id: webhookHeldDeliveries.id, payload: webhookHeldDeliveries.payload })
      .from(webhookHeldDeliveries)
      .where(
        and(
          eq(webhookHeldDeliveries.tenant_id, tenant_id),
          eq(webhookHeldDeliveries.inbound_id, inbound_id),
          eq(webhookHeldDeliveries.delivery_id, delivery_id),
          inArray(webhookHeldDeliveries.state, OPEN_STATES),
        ),
      ),
  );
  return row ? recoverExecutionPayload(row.payload, tenant_id, row.id, PAYLOAD_SLOT) : undefined;
}

export function heldPayload(row: HeldDeliveryRow): unknown {
  return recoverExecutionPayload(row.payload, row.tenant_id, row.id, PAYLOAD_SLOT);
}

export async function settleHeldDelivery(
  db: Executor,
  tenant_id: string,
  id: string,
  event: HeldDeliveryEvent,
  extra: { outcome_code?: string } = {},
): Promise<HeldDeliveryRow | null> {
  const state = nextHeldDeliveryState("held", event);
  if (!state) return null;
  const [row] = await withTenantScope(db, tenant_id, (tx) =>
    tx
      .update(webhookHeldDeliveries)
      .set({
        state,
        ...extra,
        settled_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(webhookHeldDeliveries.tenant_id, tenant_id),
          eq(webhookHeldDeliveries.id, id),
          eq(webhookHeldDeliveries.state, "held"),
          CLAIMABLE,
        ),
      )
      .returning(),
  );
  return row ?? null;
}

export async function claimHeldDelivery(
  db: Executor,
  tenant_id: string,
  id: string,
): Promise<ClaimedHeldDelivery | null> {
  const state = nextHeldDeliveryState("held", { kind: "claimed" }) ?? "replaying";
  const [row] = await withTenantScope(db, tenant_id, (tx) =>
    tx
      .update(webhookHeldDeliveries)
      .set({
        state,
        claim_token: randomUUID(),
        claimed_until: sql`clock_timestamp() + ${CLAIM_LEASE}`,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(webhookHeldDeliveries.tenant_id, tenant_id),
          eq(webhookHeldDeliveries.id, id),
          eq(webhookHeldDeliveries.state, "held"),
          CLAIMABLE,
        ),
      )
      .returning(),
  );
  return row?.claim_token ? { ...row, claim_token: row.claim_token } : null;
}

export async function finishHeldClaim(
  db: Executor,
  held: ClaimedHeldDelivery,
  event: { kind: "enqueued" } | { kind: "enqueue_failed" },
): Promise<HeldDeliveryRow | null> {
  const state = nextHeldDeliveryState("replaying", event) ?? "held";
  const [row] = await withTenantScope(db, held.tenant_id, (tx) =>
    tx
      .update(webhookHeldDeliveries)
      .set({
        state,
        claim_token: null,
        claimed_until: null,
        settled_at: state === "replayed" ? sql`clock_timestamp()` : null,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(webhookHeldDeliveries.tenant_id, held.tenant_id),
          eq(webhookHeldDeliveries.id, held.id),
          eq(webhookHeldDeliveries.state, "replaying"),
          eq(webhookHeldDeliveries.claim_token, held.claim_token),
        ),
      )
      .returning(),
  );
  return row ?? null;
}

export async function reclaimLapsedHeldClaims(db: Executor) {
  return withSystemScope(db, "held inbound replay claims lapse across every tenant", (tx) =>
    tx
      .update(webhookHeldDeliveries)
      .set({
        state: nextHeldDeliveryState("replaying", { kind: "lease_elapsed" }) ?? "held",
        claim_token: null,
        claimed_until: null,
        updated_at: sql`clock_timestamp()`,
      })
      // tenant-filter:exempt — the lease sweep returns lapsed replay claims of every tenant to held
      .where(
        and(
          eq(webhookHeldDeliveries.state, "replaying"),
          lte(webhookHeldDeliveries.claimed_until, sql`clock_timestamp()`),
        ),
      )
      .returning({
        tenant_id: webhookHeldDeliveries.tenant_id,
        inbound_id: webhookHeldDeliveries.inbound_id,
        delivery_id: webhookHeldDeliveries.delivery_id,
      }),
  );
}

export async function readReplayTarget(db: Executor, held: HeldDeliveryRow) {
  const inbound_id = held.inbound_id;
  const [binding] = inbound_id
    ? await withTenantScope(db, held.tenant_id, (tx) =>
        tx
          .select()
          .from(webhooksInbound)
          .where(
            and(eq(webhooksInbound.tenant_id, held.tenant_id), eq(webhooksInbound.id, inbound_id)),
          ),
      )
    : [];
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, held.tenant_id), eq(workflows.id, held.workflow_id)));
  return { binding, workflow };
}

export async function readRecordedExecution(db: Executor, held: HeldDeliveryRow) {
  if (!held.execution_id) return null;
  const [execution] = await db
    .select({ status: executions.status, workflow_id: executions.workflow_id })
    .from(executions)
    .where(and(eq(executions.tenant_id, held.tenant_id), eq(executions.id, held.execution_id)))
    .limit(1);
  return { execution_id: held.execution_id, execution: execution ?? null };
}

export async function recordHeldExecution(db: Executor, held: HeldDeliveryRow, execution: string) {
  await withTenantScope(db, held.tenant_id, (tx) =>
    tx
      .update(webhookHeldDeliveries)
      .set({ execution_id: execution })
      .where(
        and(
          eq(webhookHeldDeliveries.tenant_id, held.tenant_id),
          eq(webhookHeldDeliveries.id, held.id),
        ),
      ),
  );
}

export async function heldDeliveryIds(
  db: Executor,
  scope: { tenant_id: string; workflow_id: string },
): Promise<string[]> {
  const rows = await withTenantScope(db, scope.tenant_id, (tx) =>
    tx
      .select({ id: webhookHeldDeliveries.id })
      .from(webhookHeldDeliveries)
      .where(
        and(
          eq(webhookHeldDeliveries.tenant_id, scope.tenant_id),
          eq(webhookHeldDeliveries.workflow_id, scope.workflow_id),
          eq(webhookHeldDeliveries.state, "held"),
          CLAIMABLE,
        ),
      )
      .orderBy(asc(webhookHeldDeliveries.created_at), asc(webhookHeldDeliveries.id))
      .limit(HELD_DELIVERY_LIMITS.replay_batch),
  );
  return rows.map((row) => row.id);
}

export async function expireHeldDeliveries(db: Executor) {
  return withSystemScope(db, "held inbound deliveries expire across every tenant", async (tx) => {
    const expired = await tx
      .update(webhookHeldDeliveries)
      .set({
        state: "expired",
        settled_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
      })
      // tenant-filter:exempt — the expiry sweep settles held deliveries of every tenant by their own deadline
      .where(
        and(
          eq(webhookHeldDeliveries.state, "held"),
          isNull(webhookHeldDeliveries.execution_id),
          lte(webhookHeldDeliveries.expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning({
        tenant_id: webhookHeldDeliveries.tenant_id,
        inbound_id: webhookHeldDeliveries.inbound_id,
        delivery_id: webhookHeldDeliveries.delivery_id,
      });
    await tx
      .delete(webhookHeldDeliveries)
      // tenant-filter:exempt — settled held deliveries of every tenant are pruned after the same retention
      .where(
        and(
          notInArray(webhookHeldDeliveries.state, OPEN_STATES),
          lte(webhookHeldDeliveries.settled_at, sql`clock_timestamp() - ${RETENTION}`),
        ),
      );
    return expired;
  });
}

export async function heldDeliveriesDueForResume(db: Executor) {
  // tenant-filter:exempt — the resume sweep finds admitted held deliveries of every tenant, then replays each in its own scope
  return withSystemScope(
    db,
    "admitted held inbound deliveries resume until their run is queued",
    (tx) =>
      tx
        .select({ tenant_id: webhookHeldDeliveries.tenant_id, id: webhookHeldDeliveries.id })
        .from(webhookHeldDeliveries)
        .where(
          and(
            eq(webhookHeldDeliveries.state, "held"),
            isNotNull(webhookHeldDeliveries.execution_id),
          ),
        )
        .orderBy(asc(webhookHeldDeliveries.updated_at), asc(webhookHeldDeliveries.id))
        .limit(HELD_DELIVERY_LIMITS.replay_batch),
  );
}

export async function workflowsWithReleasedHolds(db: Executor) {
  // tenant-filter:exempt — the replay sweep finds released hooks of every tenant, then replays each tenant in its own scope
  return withSystemScope(db, "held inbound deliveries replay once their hook is released", (tx) =>
    tx
      .selectDistinct({
        tenant_id: webhookHeldDeliveries.tenant_id,
        workflow_id: webhookHeldDeliveries.workflow_id,
      })
      .from(webhookHeldDeliveries)
      .innerJoin(
        webhooksInbound,
        and(
          eq(webhooksInbound.tenant_id, webhookHeldDeliveries.tenant_id),
          eq(webhooksInbound.id, webhookHeldDeliveries.inbound_id),
        ),
      )
      .where(
        and(
          eq(webhookHeldDeliveries.state, "held"),
          eq(webhooksInbound.active, true),
          isNull(webhooksInbound.admission_hold),
        ),
      )
      .limit(HELD_DELIVERY_LIMITS.replay_batch),
  );
}
