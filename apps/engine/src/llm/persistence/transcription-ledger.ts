import { and, eq, inArray, lt, type SQL, sql } from "drizzle-orm";
import { type Executor, llmUsage } from "../../db/index.ts";
import { logger } from "../../logging/index.ts";
import { currentMonthBucket } from "../accounting/budget.ts";
import { audioSpendUsd, readSpend } from "../accounting/spend.ts";
import {
  type PriorAttempt,
  priorAttempt,
  reservationFits,
  reservationSources,
  type TranscriptionReservationEvent,
} from "../core/transcription-reservation.ts";

const FLOW = "transcription";
const RESERVATION_LEASE = sql`interval '10 minutes'`;

export interface TranscriptionKey {
  readonly tenant_id: string;
  readonly client_request_id: string;
}

export interface TranscriptionReservationRequest extends TranscriptionKey {
  readonly model: string;
  readonly estimate_seconds: number;
  readonly user_id: string | null;
  readonly actor_type: "user" | "system_account" | "system";
}

export interface StoredTranscription {
  readonly text: string;
  readonly model: string;
  readonly latency_ms: number;
}

export type TranscriptionPrior =
  | { readonly kind: "fresh" | "in_progress" | "unsettled" }
  | ({ readonly kind: "replay" } & StoredTranscription);

export type TranscriptionReservation =
  | TranscriptionPrior
  | { readonly kind: "reserved" }
  | { readonly kind: "spend_limit" };

export interface TranscriptionSettlement extends TranscriptionKey {
  readonly model: string;
  readonly audio_seconds: number;
  readonly latency_ms: number;
  readonly transcript: string;
}

const keyed = (key: TranscriptionKey) =>
  and(
    eq(llmUsage.tenant_id, key.tenant_id),
    eq(llmUsage.flow, FLOW),
    eq(llmUsage.client_request_id, key.client_request_id),
  );

const guarded = (key: TranscriptionKey, event: TranscriptionReservationEvent) =>
  and(keyed(key), inArray(llmUsage.reservation, reservationSources(event)));

async function lockTenantSpend(tx: Executor, tenant_id: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenant_id}:transcription:spend`}, 0))`,
  );
}

async function lapseReservations(exec: Executor, scope: SQL): Promise<number> {
  const lapsed = await exec
    .update(llmUsage)
    .set({ reservation: "reconciliation_required", lease_until: null })
    .where(
      and(
        scope,
        eq(llmUsage.flow, FLOW),
        inArray(llmUsage.reservation, reservationSources("lapse")),
        lt(llmUsage.lease_until, sql`clock_timestamp()`),
      ),
    )
    .returning({ tenant_id: llmUsage.tenant_id, client_request_id: llmUsage.client_request_id });
  for (const row of lapsed)
    logger.warn({
      module: "llm",
      action: "transcription.reservation_lapsed",
      msg: "transcription reservation outlived its lease; it stays charged until reconciled",
      tenant_id: row.tenant_id,
      client_request_id: row.client_request_id,
    });
  return lapsed.length;
}

async function readPrior(exec: Executor, key: TranscriptionKey) {
  const [row] = await exec
    .select({
      reservation: llmUsage.reservation,
      transcript: llmUsage.transcript,
      model: llmUsage.model,
      latency_ms: llmUsage.latency_ms,
    })
    .from(llmUsage)
    .where(keyed(key))
    .limit(1);
  return row;
}

function priorOf(row: Awaited<ReturnType<typeof readPrior>>): TranscriptionPrior {
  const kind: PriorAttempt = priorAttempt(row?.reservation ?? null, row?.transcript != null);
  if (kind === "replay" && row?.transcript != null)
    return { kind, text: row.transcript, model: row.model, latency_ms: row.latency_ms };
  return { kind: kind === "replay" ? "unsettled" : kind };
}

export async function priorTranscription(
  key: TranscriptionKey,
  exec: Executor,
): Promise<TranscriptionPrior> {
  return priorOf(await readPrior(exec, key));
}

export async function reserveTranscription(
  request: TranscriptionReservationRequest,
  exec: Executor,
): Promise<TranscriptionReservation> {
  return exec.transaction(async (tx) => {
    await lockTenantSpend(tx, request.tenant_id);
    await lapseReservations(tx, eq(llmUsage.tenant_id, request.tenant_id));
    const row = await readPrior(tx, request);
    const prior = priorOf(row);
    if (prior.kind !== "fresh") return prior;
    const estimate = audioSpendUsd(request.tenant_id, request.model, request.estimate_seconds);
    if (!reservationFits(await readSpend(request.tenant_id, tx), estimate))
      return { kind: "spend_limit" };
    const charge = {
      model: request.model,
      audio_seconds: request.estimate_seconds,
      latency_ms: 0,
      result: "success",
      error: null,
      transcript: null,
      reservation: "reserved" as const,
      lease_until: sql`clock_timestamp() + ${RESERVATION_LEASE}`,
      user_id: request.user_id,
      actor_type: request.actor_type,
      month_bucket: currentMonthBucket(),
      created_at: sql`clock_timestamp()`,
    };
    const claimed = row
      ? await tx
          .update(llmUsage)
          .set(charge)
          .where(guarded(request, "reserve"))
          .returning({ id: llmUsage.id })
      : await tx
          .insert(llmUsage)
          .values({
            ...charge,
            tenant_id: request.tenant_id,
            flow: FLOW,
            client_request_id: request.client_request_id,
          })
          .onConflictDoNothing()
          .returning({ id: llmUsage.id });
    return claimed.length > 0 ? { kind: "reserved" } : { kind: "in_progress" };
  });
}

export async function settleTranscription(
  settlement: TranscriptionSettlement,
  exec: Executor,
): Promise<boolean> {
  const settled = await exec
    .update(llmUsage)
    .set({
      reservation: "settled",
      lease_until: null,
      model: settlement.model,
      audio_seconds: Math.max(0, settlement.audio_seconds),
      latency_ms: Math.max(0, Math.round(settlement.latency_ms)),
      transcript: settlement.transcript,
      result: "success",
      error: null,
    })
    .where(guarded(settlement, "settle"))
    .returning({ id: llmUsage.id });
  return settled.length > 0;
}

export async function releaseTranscription(
  key: TranscriptionKey & { readonly latency_ms: number },
  exec: Executor,
): Promise<boolean> {
  const released = await exec
    .update(llmUsage)
    .set({
      reservation: "released",
      lease_until: null,
      audio_seconds: 0,
      latency_ms: Math.max(0, Math.round(key.latency_ms)),
      transcript: null,
      result: "error",
      error: "transcription_failed",
    })
    .where(guarded(key, "release"))
    .returning({ id: llmUsage.id });
  return released.length > 0;
}

export async function sweepTranscriptionReservations(exec: Executor): Promise<number> {
  const lapsed = await lapseReservations(exec, sql`true`);
  logger.info({
    module: "llm",
    action: "transcription.reservation_sweep",
    msg: "transcription reservation lease sweep completed",
    lapsed,
  });
  return lapsed;
}
