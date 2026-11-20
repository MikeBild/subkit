import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { workflows, workflowsSchedules } from "../db/schema/index.ts";
import { attentionHref, type Candidate, type TenantFacts } from "./attention-readers.ts";

export const SCHEDULE_PAUSE_ATTENTION_LIMIT = 500;

export interface PausedScheduleFact {
  workflow_id: string;
  name: string | null;
  paused_at: Date | null;
  failure_class: string | null;
  consecutive_failures: number | null;
}

export function pausedScheduleCandidate(fact: PausedScheduleFact): Candidate {
  return {
    source: "schedules",
    resource: { type: "workflow", id: fact.workflow_id },
    item: {
      id: `workflow:${fact.workflow_id}`,
      class: "stopped",
      severity: "urgent",
      kind: "workflow",
      subject: { kind: "workflow", id: fact.workflow_id, name: fact.name },
      reason: "schedule_auto_paused",
      trigger: { kind: "schedule", name: null },
      cause_class: null,
      counts:
        fact.consecutive_failures === null
          ? {}
          : { consecutive_failures: fact.consecutive_failures },
      since: fact.paused_at?.toISOString() ?? null,
      deadline: null,
      detail: fact.failure_class,
      actions: [
        {
          verb: "open",
          href: attentionHref.automation(fact.workflow_id),
          primary: true,
          permission: "workflow:write",
        },
        {
          verb: "open_runs",
          href: attentionHref.failedRuns(fact.workflow_id),
          primary: false,
          permission: "execution:read",
        },
      ],
    },
  };
}

export function mergePausedSchedules(
  facts: TenantFacts,
  paused: readonly PausedScheduleFact[],
): TenantFacts {
  if (paused.length === 0) return facts;
  const replaced = new Set(paused.map((fact) => `workflow:${fact.workflow_id}`));
  return {
    ...facts,
    candidates: [
      ...facts.candidates.filter((candidate) => !replaced.has(candidate.item.id)),
      ...paused.map(pausedScheduleCandidate),
    ],
  };
}

export async function readPausedSchedules(db: Db, tenantId: string): Promise<PausedScheduleFact[]> {
  return db
    .select({
      workflow_id: workflows.id,
      name: workflows.name,
      paused_at: workflowsSchedules.paused_at,
      failure_class: workflowsSchedules.paused_failure_class,
      consecutive_failures: workflowsSchedules.paused_failure_count,
    })
    .from(workflowsSchedules)
    .innerJoin(
      workflows,
      and(
        eq(workflows.id, workflowsSchedules.workflow_id),
        eq(workflows.tenant_id, workflowsSchedules.tenant_id),
      ),
    )
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenantId),
        eq(workflowsSchedules.paused, true),
        eq(workflowsSchedules.paused_reason, "repeated_failures"),
        isNull(workflows.deleted_at),
        eq(workflows.lifecycle, "active"),
      ),
    )
    .orderBy(workflowsSchedules.paused_at, workflowsSchedules.id)
    .limit(SCHEDULE_PAUSE_ATTENTION_LIMIT);
}

export async function withPausedSchedules(
  db: Db,
  tenantId: string,
  facts: TenantFacts,
): Promise<TenantFacts> {
  if (facts.sources.schedules === "failed") return facts;
  try {
    return mergePausedSchedules(facts, await readPausedSchedules(db, tenantId));
  } catch {
    return { ...facts, sources: { ...facts.sources, schedules: "failed" } };
  }
}
