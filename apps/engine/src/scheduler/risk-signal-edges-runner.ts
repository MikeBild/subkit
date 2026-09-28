// Records the RISK_SIGNAL_RAISED / RISK_SIGNAL_CLEARED audit edges.
//
// Fires on every scheduler reconcile tick. The edges used to be a side effect
// of READING the health digest: whoever polled `GET /v1/operator/health-digest`
// (the cockpit, mostly) advanced the shared edge tracker and wrote the rows.
// A reader that stopped polling therefore stopped the audit trail — a DLQ that
// filled overnight with no browser open left no row at all. The scheduler runs
// whether or not anyone is looking, so it owns the edges now, and no read path
// writes them.
//
// At-least-once is not enough and at-most-once is worse: the edge claim and
// its audit rows commit in ONE transaction. An audit insert that fails (the
// likeliest moment is exactly the pool saturation being reported) rolls the
// claim back, so the next tick sees the same transition and records it then —
// never a flipped edge with no row behind it.
//
// Every engine process runs the reconciler. Shared signals (the dead-letter
// queues, the month's allowance) are one edge for the deployment; a process's
// own gauges (pool, RSS, retries, calls) are that process's edge, keyed by its
// instance — see `riskEdgeKey`.
//
// The rows land under the system tenant: the signals are host-scoped, not a
// reader's. The month's allowance is the one tenant-scoped input: the worst
// tenant that has a cap speaks for the deployment's `token_budget` edge.

import { hostname } from "node:os";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import {
  RiskSignalClearedMetadataSchema,
  RiskSignalRaisedMetadataSchema,
  SYSTEM_TENANT_ID,
} from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { llmUsage, tenants } from "../db/schema/index.ts";
import { currentMonthBucket, resolveMonthlyBudget } from "../llm/accounting/index.ts";
import {
  computeRiskSignals,
  type RiskSignal,
  SHARED_RISK_KINDS,
  takeRiskEdges,
} from "../operator/risk-signals.ts";

/**
 * The worst month allowance among the tenants that have one. Tenants without a
 * cap are never summed, and the ones with a cap are summed in one grouped read.
 */
async function worstTokenBudgetSignal(db: Db): Promise<RiskSignal | null> {
  // tenant-filter:exempt — the allowance is evaluated for every live tenant.
  const live = await db.select({ id: tenants.id }).from(tenants).where(isNull(tenants.deleted_at));
  const capped = live.flatMap((tenant) => {
    const budget = resolveMonthlyBudget(tenant.id);
    return budget === null ? [] : [{ id: tenant.id, budget }];
  });
  if (capped.length === 0) return null;
  const sums = await db
    .select({
      tenant_id: llmUsage.tenant_id,
      total: sql<number>`coalesce(sum(${llmUsage.total_tokens}), 0)::int`,
    })
    .from(llmUsage)
    .where(
      and(
        inArray(
          llmUsage.tenant_id,
          capped.map((tenant) => tenant.id),
        ),
        eq(llmUsage.month_bucket, currentMonthBucket()),
      ),
    )
    .groupBy(llmUsage.tenant_id);
  const used = new Map(sums.map((row) => [row.tenant_id, Number(row.total)]));
  let worst: RiskSignal | null = null;
  for (const tenant of capped) {
    const signal = computeRiskSignals({
      monthTokens: used.get(tenant.id) ?? 0,
      monthBudget: tenant.budget,
    }).find((s) => s.kind === "token_budget");
    if (signal && (!worst || signal.value > worst.value)) worst = signal;
  }
  return worst;
}

export interface RiskSignalEdgeOptions {
  /** This process's identity for its process-local edges. Defaults to the host name. */
  instance?: string;
}

export async function runRiskSignalEdges(
  db: Db,
  opts: RiskSignalEdgeOptions = {},
): Promise<{ raised: string[]; cleared: string[] }> {
  const instance = opts.instance ?? hostname();
  const host = computeRiskSignals().filter((s) => s.kind !== "token_budget");
  const budget = await worstTokenBudgetSignal(db);
  const signals = budget ? [...host, budget] : host;
  const processLocal = (kind: string) => (SHARED_RISK_KINDS.has(kind) ? {} : { instance });

  return db.transaction(async (tx) => {
    const edges = await takeRiskEdges(tx, signals, instance);
    for (const r of edges.raised) {
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.RISK_SIGNAL_RAISED,
          resource_type: "operator_health_digest",
          resource_id: r.kind,
          result: "success",
          metadata: RiskSignalRaisedMetadataSchema.parse({
            kind: r.kind,
            severity: r.severity,
            metric: r.metric,
            value: r.value,
            threshold: r.threshold,
            // Boot-artifact discriminator: a low uptime means this raise is the
            // first tick after a restart re-firing a standing critical, not a
            // fresh live transition.
            uptime_s: Math.round(process.uptime()),
            request_source: "scheduler",
            ...processLocal(r.kind),
          }),
        },
        tx,
      );
    }
    for (const kind of edges.cleared) {
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.RISK_SIGNAL_CLEARED,
          resource_type: "operator_health_digest",
          resource_id: kind,
          result: "success",
          metadata: RiskSignalClearedMetadataSchema.parse({
            kind,
            request_source: "scheduler",
            ...processLocal(kind),
          }),
        },
        tx,
      );
    }
    return { raised: edges.raised.map((r) => r.kind), cleared: edges.cleared };
  });
}
