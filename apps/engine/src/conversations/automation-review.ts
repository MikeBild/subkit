import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { inspectScheduleAutomation } from "../scheduler/automation-status.ts";
import { listSchedules } from "../scheduler/repo.ts";
import { inboundHookAutomationView } from "../scheduler/workflow-automation-view.ts";
import {
  type EnvironmentReview,
  reviewAutomationEnvironment as reviewEnvironment,
} from "../workflows/automation-readiness.ts";
import { resolveWorkflowReviewEnvironment } from "../workflows/execution-environment.ts";
import { getWorkflow } from "../workflows/service.ts";

export function savedChangeReviewPath(workflow_id: string): string {
  return `/cockpit/workflows/${encodeURIComponent(workflow_id)}`;
}

function pendingSavedChange(workflow: {
  current_version_id?: string | null;
  draft_version_id?: string | null;
}): string | null {
  return typeof workflow.draft_version_id === "string" &&
    workflow.draft_version_id !== workflow.current_version_id
    ? workflow.draft_version_id
    : null;
}

export async function inspectAutomationReview(
  db: Db,
  tenant_id: string,
  workflow_id: string,
  options: { inbound_hooks?: { refusal_reasons: boolean } } = {},
) {
  const workflow = await getWorkflow(tenant_id, workflow_id, db);
  if (!workflow) return null;
  const version_id = workflow.draft_version_id ?? workflow.current_version_id;
  const reviews = new Map<"dev" | "prod", Promise<EnvironmentReview>>();
  const reviewFor = (environment: "dev" | "prod") => {
    let review = reviews.get(environment);
    if (!review) {
      review = reviewEnvironment(db, tenant_id, workflow_id, version_id, environment, {
        is_draft: Boolean(workflow.draft_version_id),
      });
      reviews.set(environment, review);
    }
    return review;
  };
  const { rows } = await listSchedules(db, tenant_id, workflow_id);
  const schedules = await Promise.all(
    rows.map(async (row) => ({
      environment: row.execution_mode,
      ...(await inspectScheduleAutomation(row, db)),
      review: await reviewFor(row.execution_mode),
    })),
  );
  const saved_change = await savedChangeReview(db, tenant_id, workflow, reviewFor);
  if (!options.inbound_hooks) return { workflow_id, schedules, saved_change };
  const clock = await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
  const now = clock.rows[0]?.now;
  if (!now) throw new Error("database clock unavailable");
  const hooks = await inboundHookAutomationView(
    tenant_id,
    workflow_id,
    db,
    new Date(now),
    options.inbound_hooks,
  );
  return {
    workflow_id,
    schedules,
    saved_change,
    inbound_hooks: await Promise.all(
      hooks.map(async (hook) => ({ ...hook, review: await reviewFor(hook.environment) })),
    ),
  };
}

async function savedChangeReview(
  db: Db,
  tenant_id: string,
  workflow: { id: string; current_version_id?: string | null; draft_version_id?: string | null },
  reviewFor: (environment: "dev" | "prod") => Promise<EnvironmentReview>,
) {
  const workflow_version_id = pendingSavedChange(workflow);
  if (!workflow_version_id) return null;
  let resolved: Awaited<ReturnType<typeof resolveWorkflowReviewEnvironment>>;
  try {
    resolved = await resolveWorkflowReviewEnvironment(db, tenant_id, workflow.id, {
      version_id: workflow_version_id,
    });
  } catch {
    return null;
  }
  return {
    workflow_version_id,
    current_version_id: workflow.current_version_id ?? null,
    environment: resolved.environment,
    environment_source: resolved.source,
    review: await reviewFor(resolved.environment),
  };
}
