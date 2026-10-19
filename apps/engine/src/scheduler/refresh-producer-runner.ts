import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import type { Db } from "../db/client.ts";
import { connectors, knowledgeSources } from "../db/schema/index.ts";
import { tenantWorkBootId, withTenantWork } from "../execution/index.ts";
import { lockActiveTenant } from "../identity/index.ts";
import { logger } from "../logging/logger.ts";
import { enqueueIngest, enqueueKnowledgeIngest } from "../queue/index.ts";
import { isCronDue } from "./cron.ts";
import {
  parseRefreshProjection,
  type RefreshProducer,
  refreshProjectionQuery,
} from "./refresh-producer-projection.ts";
import {
  acquireSweepPage,
  completeSweepEpoch,
  releaseSweepLease,
  type SweepCandidate,
  walkSweepPage,
  withLiveSweepLease,
} from "./sweep-cursor.ts";

function diagnostic(
  producer: RefreshProducer,
  reason: "unsupported" | "enqueue_failed",
  candidate: SweepCandidate,
) {
  logger.warn({
    module: "scheduler",
    action: "refresh_sweep.skipped",
    msg: "scheduled refresh candidate was not admitted",
    producer,
    reason,
    tenant_id: candidate.tenant_id,
    resource_id: candidate.id,
  });
}

async function runRefreshSweep(
  producer: RefreshProducer,
  db: Db,
  boss: PgBoss,
  observedAt: Date,
): Promise<void> {
  const now = new Date(z.date().parse(observedAt).getTime());
  const page = await acquireSweepPage(producer, tenantWorkBootId(), db);
  if (page.kind !== "claimed") return;
  let lease = page.lease;
  try {
    const walked = await walkSweepPage(page, db, (candidate, handle) =>
      withTenantWork(candidate.tenant_id, async () => {
        try {
          const result = await withLiveSweepLease(handle, db, async (tx) => {
            await lockActiveTenant(candidate.tenant_id, tx);
            const selected = await tx.execute(refreshProjectionQuery(producer, candidate, handle));
            const row = selected.rows[0];
            if (!row) return "visited" as const;
            const parsed = parseRefreshProjection(producer, row);
            if (parsed.kind !== "ready") {
              diagnostic(producer, "unsupported", candidate);
              return "visited" as const;
            }
            const input = parsed.input;
            if (!isCronDue(input.cron, input.last_fired_at, now)) return "visited" as const;
            const sent =
              parsed.producer === "docs"
                ? await enqueueIngest(
                    boss,
                    {
                      tenant_id: candidate.tenant_id,
                      connector_id: candidate.id,
                      source_type: parsed.input.source_type,
                      url: input.address,
                      actor_id: null,
                    },
                    tx,
                  )
                : await enqueueKnowledgeIngest(
                    boss,
                    {
                      tenant_id: candidate.tenant_id,
                      knowledge_source_id: candidate.id,
                      filename: input.address,
                      content: "",
                      actor: null,
                      read_address_again: true,
                    },
                    tx,
                  );
            if (sent === null) throw new Error("refresh_queue_not_admitted");
            if (producer === "docs") {
              await tx
                .update(connectors)
                .set({ last_ingested_at: now })
                .where(
                  and(
                    eq(connectors.tenant_id, candidate.tenant_id),
                    eq(connectors.id, candidate.id),
                  ),
                );
            } else {
              await tx
                .update(knowledgeSources)
                .set({ last_refreshed_at: now })
                .where(
                  and(
                    eq(knowledgeSources.tenant_id, candidate.tenant_id),
                    eq(knowledgeSources.id, candidate.id),
                  ),
                );
            }
            await auditAwait(
              {
                tenant_id: SYSTEM_TENANT_ID,
                actor_type: "system",
                actor_id: null,
                action: AuditAction.SCHEDULER_SWEEP_QUEUE_ADMITTED,
                resource_type: "scheduler_sweep",
                resource_id: producer,
                metadata: {
                  request_source: "scheduler",
                  producer,
                  operation: "queue_admission",
                  epoch: handle.epoch,
                  revision: handle.revision,
                  outcome: "created",
                },
              },
              tx,
            );
            return "admitted" as const;
          });
          return typeof result === "object" ? "deferred" : result;
        } catch {
          diagnostic(producer, "enqueue_failed", candidate);
          throw new Error("refresh_admission_failed");
        }
      }),
    );
    if (walked.kind === "lost_lease") return;
    lease = walked.lease;
    await completeSweepEpoch(lease, db);
  } finally {
    await releaseSweepLease(lease, db);
  }
}

export function runDocsRefreshSweep(db: Db, boss: PgBoss, now = new Date()): Promise<void> {
  return runRefreshSweep("docs", db, boss, now);
}

export function runKnowledgeRefreshSweep(db: Db, boss: PgBoss, now = new Date()): Promise<void> {
  return runRefreshSweep("knowledge", db, boss, now);
}
