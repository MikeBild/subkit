import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { withTenantScope } from "../db/index.ts";
import { webhooksInbound, workflowsSchedules } from "../db/schema/index.ts";
import type { Candidate, TenantFacts } from "./attention-readers.ts";

export type ExecutionEnvironment = "dev" | "prod";

export interface ScheduleEnvironmentRow {
  workflow_id: string;
  environment: ExecutionEnvironment;
  stopped: boolean;
}

const WORKFLOW_LOOKUP_MAX = 2000;

export function environmentOfSchedules(
  rows: readonly ScheduleEnvironmentRow[],
): ExecutionEnvironment | null {
  if (rows.length === 0) return null;
  const stopped = rows.filter((row) => row.stopped);
  const relevant = stopped.length > 0 ? stopped : rows;
  return relevant.some((row) => row.environment === "prod") ? "prod" : "dev";
}

export function workflowEnvironment(
  candidate: Candidate,
  schedules: readonly ScheduleEnvironmentRow[],
  hooked: boolean,
): ExecutionEnvironment | null {
  const { item } = candidate;
  if (item.approval) return item.approval.environment;
  if (item.trigger?.kind === "inbound_hook") return "prod";
  return environmentOfSchedules(schedules) ?? (hooked ? "prod" : null);
}

function needsEnvironment(candidate: Candidate): boolean {
  const subject = candidate.item.subject;
  return subject?.kind === "workflow" && subject.environment === undefined;
}

export function applyWorkflowEnvironments(
  facts: TenantFacts,
  schedules: readonly ScheduleEnvironmentRow[],
  hookedWorkflowIds: ReadonlySet<string>,
): TenantFacts {
  const byWorkflow = new Map<string, ScheduleEnvironmentRow[]>();
  for (const row of schedules)
    byWorkflow.set(row.workflow_id, [...(byWorkflow.get(row.workflow_id) ?? []), row]);
  return {
    ...facts,
    candidates: facts.candidates.map((candidate) => {
      const subject = candidate.item.subject;
      if (!subject || !needsEnvironment(candidate)) return candidate;
      const environment = workflowEnvironment(
        candidate,
        byWorkflow.get(subject.id) ?? [],
        hookedWorkflowIds.has(subject.id),
      );
      return environment
        ? { ...candidate, item: { ...candidate.item, subject: { ...subject, environment } } }
        : candidate;
    }),
  };
}

export async function readScheduleEnvironments(
  db: Db,
  tenantId: string,
  workflowIds: readonly string[],
): Promise<ScheduleEnvironmentRow[]> {
  if (workflowIds.length === 0) return [];
  const rows = await db
    .select({
      workflow_id: workflowsSchedules.workflow_id,
      environment: workflowsSchedules.execution_mode,
      paused: workflowsSchedules.paused,
      paused_reason: workflowsSchedules.paused_reason,
      hold: workflowsSchedules.admission_hold,
    })
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenantId),
        inArray(workflowsSchedules.workflow_id, [...workflowIds]),
      ),
    );
  return rows.map((row) => ({
    workflow_id: row.workflow_id,
    environment: row.environment,
    stopped: row.paused ? row.paused_reason !== null : row.hold !== null,
  }));
}

async function readHookedWorkflows(
  db: Db,
  tenantId: string,
  workflowIds: readonly string[],
): Promise<Set<string>> {
  if (workflowIds.length === 0) return new Set();
  const rows = await withTenantScope(db, tenantId, (tx) =>
    tx
      .select({ workflow_id: webhooksInbound.workflow_id })
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, tenantId),
          eq(webhooksInbound.active, true),
          inArray(webhooksInbound.workflow_id, [...workflowIds]),
        ),
      ),
  );
  return new Set(rows.flatMap((row) => (row.workflow_id ? [row.workflow_id] : [])));
}

export async function withExecutionEnvironments(
  db: Db,
  tenantId: string,
  facts: TenantFacts,
): Promise<TenantFacts> {
  const ids = [
    ...new Set(
      facts.candidates
        .filter(needsEnvironment)
        .flatMap((candidate) => (candidate.item.subject ? [candidate.item.subject.id] : [])),
    ),
  ].slice(0, WORKFLOW_LOOKUP_MAX);
  if (ids.length === 0) return facts;
  try {
    const [schedules, hooked] = await Promise.all([
      readScheduleEnvironments(db, tenantId, ids),
      readHookedWorkflows(db, tenantId, ids),
    ]);
    return applyWorkflowEnvironments(facts, schedules, hooked);
  } catch {
    return facts;
  }
}
