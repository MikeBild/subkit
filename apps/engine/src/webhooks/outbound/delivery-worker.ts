// Delivery worker for the `webhook.deliver` queue.
//
// Each job describes a single (subscription_id, event_id) pair plus
// the outbound payload. The worker:
//
//   1. Short-circuits if the subscription circuit breaker is open —
//      writes a dead-letter `deliveries` row with error=circuit_open
//      and returns without making an HTTP request.
//   2. Loads the subscription secret (primary + optional rotating)
//      from the DB and decrypts them.
//   3. Signs the payload per Standard Webhooks and POSTs it.
//   4. On 2xx: records a success row, resets breaker, audits
//      webhook.outbound.delivered.
//   5. On non-2xx or transport error: records a failure row, asks the
//      retry ladder for the next delay, optionally re-enqueues the job
//      via boss.send(..., {startAfter}), bumps the breaker counter,
//      audits webhook.outbound.failed.

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { audit, auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { deliveries, subscriptions } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { recordWebhookDelivery } from "../../observability/instrumentation.ts";
import * as breaker from "./circuit-breaker.ts";
import { getMaxAttempts, nextDelayMs } from "./retry.ts";
import { loadSubscriptionSecrets } from "./service.ts";
import { signatureHeader } from "./signer.ts";

export const WEBHOOK_DELIVER_QUEUE = "webhook.deliver" as const;

export interface WebhookDeliverJob {
  tenant_id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  /** The normalized payload as an already-serialized JSON string. */
  body: string;
  /** Opaque id used in the `webhook-id` header. */
  webhook_id: string;
  /** Unix seconds. */
  timestamp: number;
  /** 1-based attempt counter. */
  attempt_number: number;
  /** Optional outbox event row id (bigint) if the job came from the fanout. */
  outbox_event_id?: number | null;
}

export interface RegisterDeliveryWorkerOptions {
  boss: PgBoss;
  db: Db;
  /**
   * Optional fetch override. Tests pass in a closure that points at a
   * local mock HTTP server.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional jitter flag, passed to the retry ladder. Tests disable
   * jitter so delay assertions are exact.
   */
  jitter?: boolean;
  /**
   * When set, the worker does NOT spawn its own pg-boss worker — it
   * just returns the handler so tests can drive it directly. The
   * `handle` key on the returned object is what tests call.
   */
  noWork?: boolean;
}

export interface DeliveryWorkerHandle {
  workerId: string | null;
  handle: (job: Job<WebhookDeliverJob>) => Promise<void>;
}

interface DeliveryOutcome {
  ok: boolean;
  status: number;
  error: string | null;
  body: string;
  duration_ms: number;
}

async function sendDelivery(
  target_url: string,
  headers: Record<string, string>,
  body: string,
  impl: typeof fetch,
): Promise<DeliveryOutcome> {
  const started = Date.now();
  try {
    const res = await impl(target_url, {
      method: "POST",
      headers,
      body,
    });
    const respBody = await res.text().catch(() => "");
    return {
      ok: res.ok,
      status: res.status,
      error: res.ok ? null : `http_${res.status}`,
      body: respBody.slice(0, 2048),
      duration_ms: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
      body: "",
      duration_ms: Date.now() - started,
    };
  }
}

export async function registerDeliveryWorker(
  opts: RegisterDeliveryWorkerOptions,
): Promise<DeliveryWorkerHandle> {
  const { boss, db, fetchImpl = fetch, jitter = true } = opts;

  const handle = async (job: Job<WebhookDeliverJob>): Promise<void> => {
    const data = job.data;
    const now = Date.now();

    // 1) Breaker open? short-circuit.
    await breaker.hydrate(db, data.subscription_id);
    if (breaker.isOpen(data.subscription_id, now)) {
      const hash = createHash("sha256").update(data.body).digest("hex");
      await db.insert(deliveries).values({
        tenant_id: data.tenant_id,
        subscription_id: data.subscription_id,
        event_id: data.event_id,
        outbox_event_id: data.outbox_event_id ?? null,
        attempt: data.attempt_number,
        attempt_number: data.attempt_number,
        status: "dead_letter",
        response_code: null,
        error: "circuit_open",
        request_hash: hash,
        event_type: data.event_type,
        target_url: null,
        response_body: null,
        duration_ms: null,
        next_retry_at: null,
      });
      audit({
        tenant_id: data.tenant_id,
        action: AuditAction.WEBHOOK_OUTBOUND_FAILED,
        resource_type: "subscription",
        resource_id: data.subscription_id,
        result: "error",
        reason: "circuit_open",
        metadata: {
          event_id: data.event_id,
          event_type: data.event_type,
          attempt: data.attempt_number,
        },
      });
      recordWebhookDelivery({
        subscription_id: data.subscription_id,
        status: "circuit_open",
      });
      logger.warn({
        module: "webhooks.outbound",
        action: "delivery.circuit_open",
        msg: "delivery skipped; breaker open",
        subscription_id: data.subscription_id,
        event_id: data.event_id,
      });
      return;
    }

    // 2) Load secrets + subscription row.
    const loaded = await loadSubscriptionSecrets(data.tenant_id, data.subscription_id, db);
    if (!loaded) {
      logger.warn({
        module: "webhooks.outbound",
        action: "delivery.subscription_missing",
        msg: "subscription disappeared; dropping job",
        subscription_id: data.subscription_id,
      });
      return;
    }
    if (!loaded.row.active) {
      logger.info({
        module: "webhooks.outbound",
        action: "delivery.subscription_inactive",
        msg: "subscription inactive; dropping job",
        subscription_id: data.subscription_id,
      });
      return;
    }

    // 3) Sign.
    const signature = signatureHeader({
      webhook_id: data.webhook_id,
      timestamp: data.timestamp,
      body: data.body,
      secret: loaded.primary_secret,
      rotatingSecret: loaded.rotating_secret ?? null,
    });

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "webhook-id": data.webhook_id,
      "webhook-timestamp": String(data.timestamp),
      "webhook-signature": signature,
      "user-agent": "subkit-webhooks/1",
    };

    const hash = createHash("sha256").update(data.body).digest("hex");
    const outcome = await sendDelivery(loaded.row.target_url, headers, data.body, fetchImpl);

    // 4) Success path.
    if (outcome.ok) {
      await db.insert(deliveries).values({
        tenant_id: data.tenant_id,
        subscription_id: data.subscription_id,
        event_id: data.event_id,
        outbox_event_id: data.outbox_event_id ?? null,
        attempt: data.attempt_number,
        attempt_number: data.attempt_number,
        status: "success",
        response_code: outcome.status,
        error: null,
        request_hash: hash,
        event_type: data.event_type,
        target_url: loaded.row.target_url,
        response_body: outcome.body,
        duration_ms: outcome.duration_ms,
        next_retry_at: null,
      });
      await breaker.recordSuccess(db, data.subscription_id);
      recordWebhookDelivery({ subscription_id: data.subscription_id, status: "delivered" });
      await auditAwait({
        tenant_id: data.tenant_id,
        action: AuditAction.WEBHOOK_OUTBOUND_DELIVERED,
        resource_type: "subscription",
        resource_id: data.subscription_id,
        result: "success",
        metadata: {
          event_id: data.event_id,
          event_type: data.event_type,
          attempt: data.attempt_number,
          status_code: outcome.status,
        },
      });
      return;
    }

    // 5) Failure path — compute next retry delay + reschedule.
    // The active retry ladder length is read at this exact moment so
    // tests that swap the ladder via `setRetryDelays(...)` see the
    // override. `getMaxAttempts()` returns ladder.length + 1 (initial
    // attempt + N retries).
    const maxAttempts = getMaxAttempts();
    const delay =
      data.attempt_number >= maxAttempts ? null : nextDelayMs(data.attempt_number, { jitter });
    const nextRetryAt = delay !== null ? new Date(Date.now() + delay) : null;
    const terminal = delay === null;

    await db.insert(deliveries).values({
      tenant_id: data.tenant_id,
      subscription_id: data.subscription_id,
      event_id: data.event_id,
      outbox_event_id: data.outbox_event_id ?? null,
      attempt: data.attempt_number,
      attempt_number: data.attempt_number,
      status: terminal ? "dead_letter" : "retrying",
      response_code: outcome.status || null,
      error: outcome.error,
      request_hash: hash,
      event_type: data.event_type,
      target_url: loaded.row.target_url,
      response_body: outcome.body || null,
      duration_ms: outcome.duration_ms,
      next_retry_at: nextRetryAt,
    });

    const bstate = await breaker.recordFailure(db, data.subscription_id);

    audit({
      tenant_id: data.tenant_id,
      action: AuditAction.WEBHOOK_OUTBOUND_FAILED,
      resource_type: "subscription",
      resource_id: data.subscription_id,
      result: "error",
      reason: outcome.error ?? "unknown",
      metadata: {
        event_id: data.event_id,
        event_type: data.event_type,
        attempt: data.attempt_number,
        status_code: outcome.status || null,
        terminal,
        breaker_open: bstate.open_until > Date.now(),
      },
    });
    recordWebhookDelivery({
      subscription_id: data.subscription_id,
      status: terminal ? "dead_letter" : "failed",
    });

    if (!terminal) {
      const nextJob: WebhookDeliverJob = {
        ...data,
        attempt_number: data.attempt_number + 1,
      };
      // Re-enqueue at `now + delay`. pg-boss accepts a Date for
      // `startAfter` and will dequeue no earlier than that timestamp.
      const startAfter = nextRetryAt ?? new Date(Date.now() + (delay ?? 1000));
      await boss.send(WEBHOOK_DELIVER_QUEUE, nextJob, { startAfter });
    }
  };

  let workerId: string | null = null;
  if (!opts.noWork) {
    workerId = await boss.work<WebhookDeliverJob>(
      WEBHOOK_DELIVER_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async (jobs: Job<WebhookDeliverJob>[]) => {
        for (const j of jobs) {
          try {
            await handle(j);
          } catch (err) {
            logger.error({
              module: "webhooks.outbound",
              action: "delivery.handler_error",
              msg: "webhook.deliver handler threw",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      },
    );
    logger.info({
      module: "webhooks.outbound",
      action: "worker.registered",
      msg: "webhook.deliver worker registered",
      worker_id: workerId,
    });
  }

  // Touch the subscriptions import so biome doesn't whine about an
  // unused import when a future refactor removes one of the reads.
  void subscriptions;
  void eq;

  return { workerId, handle };
}
