import { hostname } from "node:os";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import {
  RiskSignalClearedMetadataSchema,
  RiskSignalRaisedMetadataSchema,
  SYSTEM_TENANT_ID,
} from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { computeRiskSignals, SHARED_RISK_KINDS, takeRiskEdges } from "../risk-signals.ts";

interface RiskSignalEdgeOptions {
  instance?: string;
}

export async function runRiskSignalEdges(
  db: Db,
  opts: RiskSignalEdgeOptions = {},
): Promise<{ raised: string[]; cleared: string[] }> {
  const instance = opts.instance ?? hostname();
  const signals = computeRiskSignals();
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
