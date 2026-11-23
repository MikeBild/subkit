import { type SQL, sql } from "drizzle-orm";
import {
  connectors,
  knowledgeSources,
  type SchedulerSweepProducer,
  tenants,
  workflows,
  workflowsSchedules,
} from "../db/schema/index.ts";

export const SWEEP_CADENCE_MS = {
  drift: 60 * 60 * 1000,
  reauth: 60 * 60 * 1000,
  "endpoint-contract": 6 * 60 * 60 * 1000,
  skill: 6 * 60 * 60 * 1000,
  notes: 60 * 60 * 1000,
} as const;

export type SweepCadenceProducer = keyof typeof SWEEP_CADENCE_MS;

export function sweepSource(producer: SchedulerSweepProducer): SQL {
  switch (producer) {
    case "task":
    case "notes":
    case "catalog":
    case "drift":
    case "reauth":
    case "endpoint-contract":
    case "skill":
      return sql`SELECT t.id, t.id AS tenant_id, t.created_at FROM ${tenants} t
        WHERE t.status = 'active' AND t.deleted_at IS NULL`;
    case "docs":
      return sql`SELECT c.id, c.tenant_id, c.created_at FROM ${connectors} c
        INNER JOIN ${tenants} t ON t.id = c.tenant_id
        WHERE t.status = 'active' AND t.deleted_at IS NULL
          AND c.deleted_at IS NULL AND c.auto_refresh_cron IS NOT NULL`;
    case "workflow-cron":
      return sql`SELECT s.id, s.tenant_id, s.created_at FROM ${workflowsSchedules} s
        INNER JOIN ${workflows} w ON w.id = s.workflow_id AND w.tenant_id = s.tenant_id
        INNER JOIN ${tenants} t ON t.id = s.tenant_id
        WHERE t.status = 'active' AND t.deleted_at IS NULL AND s.paused = false
          AND w.deleted_at IS NULL AND w.lifecycle <> 'archived'`;
    case "knowledge":
      return sql`SELECT k.id, k.tenant_id, k.created_at FROM ${knowledgeSources} k
        INNER JOIN ${tenants} t ON t.id = k.tenant_id
        WHERE t.status = 'active' AND t.deleted_at IS NULL
          AND k.refresh_strategy = 'scheduled' AND k.source_type = 'url'
          AND k.status IN ('active', 'error') AND k.deleted_at IS NULL
          AND k.refresh_cron IS NOT NULL`;
  }
}

export function sweepCadenceColumn(producer: SweepCadenceProducer) {
  switch (producer) {
    case "drift":
      return tenants.last_proactive_scan_at;
    case "reauth":
      return tenants.last_connector_reauth_scan_at;
    case "endpoint-contract":
      return tenants.last_endpoint_contract_scan_at;
    case "skill":
      return tenants.last_skill_candidate_analyze_at;
    case "notes":
      return tenants.last_personal_notes_scan_at;
  }
}
