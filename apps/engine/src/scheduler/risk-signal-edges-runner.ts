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
// The signals are host-scoped (process gauges), so the rows land under the
// system tenant, exactly as before. The month's token allowance is the one
// tenant-scoped input: every live tenant's allowance is evaluated, and the
// worst one speaks for the host's `token_budget` edge — per tenant it would
// flap the one shared edge row between tenants on every tick.
//
// `takeRiskEdges` claims each transition through a shared table, so several
// replicas ticking at once still write each edge exactly once.

import { isNull } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import {
  RiskSignalClearedMetadataSchema,
  RiskSignalRaisedMetadataSchema,
  SYSTEM_TENANT_ID,
} from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";
import { monthlyUsage, resolveMonthlyBudget } from "../llm/accounting/index.ts";
import { computeRiskSignals, type RiskSignal, takeRiskEdges } from "../operator/risk-signals.ts";

async function worstTokenBudgetSignal(db: Db): Promise<RiskSignal | null> {
  // tenant-filter:exempt — the allowance is evaluated for every live tenant.
  const live = await db.select({ id: tenants.id }).from(tenants).where(isNull(tenants.deleted_at));
  let worst: RiskSignal | null = null;
  for (const tenant of live) {
    const signal = computeRiskSignals({
      monthTokens: await monthlyUsage(tenant.id, db),
      monthBudget: resolveMonthlyBudget(tenant.id),
    }).find((s) => s.kind === "token_budget");
    if (signal && (!worst || signal.value > worst.value)) worst = signal;
  }
  return worst;
}

export async function runRiskSignalEdges(db: Db): Promise<{ raised: string[]; cleared: string[] }> {
  const host = computeRiskSignals().filter((s) => s.kind !== "token_budget");
  const budget = await worstTokenBudgetSignal(db);
  const edges = await takeRiskEdges(db, budget ? [...host, budget] : host);
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
        }),
      },
      db,
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
        metadata: RiskSignalClearedMetadataSchema.parse({ kind, request_source: "scheduler" }),
      },
      db,
    );
  }
  return { raised: edges.raised.map((r) => r.kind), cleared: edges.cleared };
}
