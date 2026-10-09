import {
  automationEnvironment,
  automationState,
  type WorkflowAuthority,
} from "@shared/workflow-automation.ts";
import {
  type WorkflowOperatingStatus,
  workflowOperatingStatus,
} from "@shared/workflow-operating-status.ts";
import {
  deletedConnectorReference,
  type WaitingConnector,
  workflowStrip,
} from "@shared/workflow-strip.ts";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import {
  connectors,
  patchCandidates,
  webhooksInbound,
  workflowExecutionAuthorities,
  workflowsSchedules,
} from "../db/schema/index.ts";
import { observeWorkflowAuthority } from "./authority-observation.ts";
import { diagnoseWorkflow } from "./gate-diagnosis.ts";
import type { WorkflowView } from "./service.ts";

export interface OperatingStatusAccess {
  schedules: boolean;
  hooks: boolean;
  connectors: boolean;
}

export async function loadWorkflowOperatingStates(
  db: Executor,
  tenant_id: string,
  views: WorkflowView[],
  access: OperatingStatusAccess,
  now: Date,
): Promise<Map<string, WorkflowOperatingStatus>> {
  if (!views.length) return new Map();
  const { inspectInboundHookAutomation, inspectScheduleAutomation } = await import(
    "../scheduler/index.ts"
  );
  const { readPatchReadinessBatch } = await import("../self-healing/index.ts");
  const ids = views.map((view) => view.id);
  const [scheduleRows, hookRows, authorityRows, candidates, connectorRows] = await Promise.all([
    access.schedules
      ? db
          .select()
          .from(workflowsSchedules)
          .where(
            and(
              eq(workflowsSchedules.tenant_id, tenant_id),
              inArray(workflowsSchedules.workflow_id, ids),
            ),
          )
      : [],
    db
      .select()
      .from(webhooksInbound)
      .where(
        and(eq(webhooksInbound.tenant_id, tenant_id), inArray(webhooksInbound.workflow_id, ids)),
      ),
    db
      .select()
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, tenant_id),
          inArray(workflowExecutionAuthorities.workflow_id, ids),
        ),
      )
      .orderBy(
        desc(workflowExecutionAuthorities.created_at),
        desc(workflowExecutionAuthorities.id),
      ),
    db
      .select()
      .from(patchCandidates)
      .where(
        and(
          eq(patchCandidates.tenant_id, tenant_id),
          inArray(patchCandidates.workflow_id, ids),
          eq(patchCandidates.status, "proposed"),
        ),
      ),
    access.connectors
      ? db
          .select({
            id: connectors.id,
            slug: connectors.slug,
            name: connectors.display_name,
            needs_reauth: connectors.needs_reauth,
            health_state: connectors.health_state,
          })
          .from(connectors)
          .where(and(eq(connectors.tenant_id, tenant_id), isNull(connectors.deleted_at)))
      : [],
  ]);
  const readiness = await readPatchReadinessBatch(tenant_id, candidates, db);
  const preparedRepairs = new Set(
    candidates
      .filter((_row, index) => readiness[index]?.reviewable && readiness[index]?.review_digest)
      .map((row) => row.workflow_id),
  );
  const result = new Map<string, WorkflowOperatingStatus>();
  for (const view of views) {
    const schedules = scheduleRows.filter((row) => row.workflow_id === view.id);
    const hooks = hookRows.filter((row) => row.workflow_id === view.id);
    let authorities: WorkflowAuthority[] | null = [];
    try {
      for (const row of authorityRows.filter((row) => row.workflow_id === view.id)) {
        authorities.push(await observeWorkflowAuthority(db, row, view, now));
      }
    } catch {
      authorities = null;
    }
    const verifiedSchedules = [];
    const verifiedHooks = [];
    if (access.schedules) {
      for (const schedule of schedules) {
        verifiedSchedules.push({
          ...(await inspectScheduleAutomation(schedule, db)),
          cron: schedule.cron,
          timezone: schedule.timezone,
          environment: schedule.execution_mode,
          next_run_at: null,
        });
      }
      if (access.hooks)
        for (const hook of hooks) {
          verifiedHooks.push({
            ...(await inspectInboundHookAutomation(hook, db)),
            slug: hook.slug,
            environment: "prod" as const,
          });
        }
    }
    const inputs = {
      workflow: { ...view, webhooks_active: hooks.filter((hook) => hook.active).length },
      schedules: access.schedules ? schedules : null,
      status: access.schedules
        ? { schedules: verifiedSchedules, inbound_hooks: verifiedHooks }
        : null,
      authorities,
      now: now.getTime(),
    };
    const environment = automationEnvironment(inputs);
    let diagnosis = null;
    let diagnosisUnavailable = false;
    try {
      diagnosis = await diagnoseWorkflow(db, tenant_id, view.id, environment);
    } catch {
      diagnosisUnavailable = true;
    }
    const automation = automationState({
      ...inputs,
      diagnosis,
      unanswered: { status: false, diagnosis: diagnosisUnavailable },
    });
    let waitingConnector: WaitingConnector | null = deletedConnectorReference(
      view.connector_references,
    );
    if (!waitingConnector) {
      for (const reference of view.connector_references) {
        const record = connectorRows.find(
          (row) => row.id === reference.connector_id || row.slug === reference.slug,
        );
        if (record && (record.needs_reauth || record.health_state === "needs_reauth")) {
          waitingConnector = { id: record.id, name: record.name, state: "expired" };
          break;
        }
      }
    }
    const strip = workflowStrip({
      automation,
      failed: false,
      disabled: view.lifecycle === "archived",
      noSteps: view.steps.length === 0,
      health: view.health_state,
      failedRunId: null,
      repairPrepared: preparedRepairs.has(view.id),
      waitingConnector,
      rights: { write: false, chat: false },
    });
    result.set(view.id, workflowOperatingStatus(strip.kind));
  }
  return result;
}
