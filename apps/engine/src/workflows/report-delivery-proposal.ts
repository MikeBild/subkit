import { and, desc, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { executionSteps, executions, workflowExecutionAuthorities } from "../db/schema/index.ts";
import {
  type ReportDeliveryBoundary,
  ReportDeliveryBoundarySchema,
} from "./report-delivery-boundary.ts";

export type ReportDeliveryBoundaries = Record<string, ReportDeliveryBoundary>;

/** Evidence for repair diagnosis, without credentials or message contents.
 * A succeeded held run can still contain unexecuted dependent steps. */
export async function inspectHeldPreviewEvidence(
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
  },
  db: Executor,
) {
  const [run] = await db
    .select({ id: executions.id, status: executions.status })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, input.tenant_id),
        eq(executions.workflow_id, input.workflow_id),
        eq(executions.workflow_version_id, input.workflow_version_id),
        eq(executions.execution_mode, input.execution_environment),
        eq(executions.hold_writes, true),
      ),
    )
    .orderBy(desc(executions.created_at), desc(executions.id))
    .limit(1);
  if (!run) return null;
  const steps = await db
    .select({
      step_id: executionSteps.step_key,
      status: executionSteps.status,
      meta: executionSteps.request_meta,
    })
    .from(executionSteps)
    .where(
      and(eq(executionSteps.tenant_id, input.tenant_id), eq(executionSteps.execution_id, run.id)),
    );
  return {
    execution_id: run.id,
    status: run.status,
    steps: steps.map(({ step_id, status, meta }) => {
      const extras = (
        meta as { extras?: { held?: boolean; report_delivery_proposal?: unknown } } | null
      )?.extras;
      return {
        step_id,
        status,
        held: extras?.held === true,
        report_boundary_observed: ReportDeliveryBoundarySchema.safeParse(
          extras?.report_delivery_proposal,
        ).success,
      };
    }),
  };
}

/** Existing human-approved boundaries survive changing report content and
 * preview retention. Without a grant, derive a proposal from an exact-version
 * successful held run. This read never executes or authorizes anything. */
export async function proposeReportDeliveryBoundaries(
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
  },
  db: Executor,
): Promise<ReportDeliveryBoundaries> {
  const [authority] = await db
    .select({ manifest: workflowExecutionAuthorities.effect_manifest })
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, input.tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, input.workflow_id),
        eq(workflowExecutionAuthorities.workflow_version_id, input.workflow_version_id),
        eq(workflowExecutionAuthorities.execution_environment, input.execution_environment),
      ),
    )
    .orderBy(desc(workflowExecutionAuthorities.created_at), desc(workflowExecutionAuthorities.id))
    .limit(1);
  if (authority) return reportBoundariesFromManifest(authority.manifest);
  const [run] = await db
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, input.tenant_id),
        eq(executions.workflow_id, input.workflow_id),
        eq(executions.workflow_version_id, input.workflow_version_id),
        eq(executions.execution_mode, input.execution_environment),
        eq(executions.status, "succeeded"),
        eq(executions.hold_writes, true),
      ),
    )
    .orderBy(desc(executions.created_at), desc(executions.id))
    .limit(1);
  if (!run) return {};
  const steps = await db
    .select({ key: executionSteps.step_key, meta: executionSteps.request_meta })
    .from(executionSteps)
    .where(
      and(eq(executionSteps.tenant_id, input.tenant_id), eq(executionSteps.execution_id, run.id)),
    );
  const boundaries: ReportDeliveryBoundaries = {};
  for (const step of steps) {
    const metadata = step.meta as {
      extras?: { held?: boolean; report_delivery_proposal?: unknown };
    } | null;
    const proposal = ReportDeliveryBoundarySchema.safeParse(
      metadata?.extras?.report_delivery_proposal,
    );
    if (metadata?.extras?.held === true && proposal.success) boundaries[step.key] = proposal.data;
  }
  return boundaries;
}

export function reportBoundariesFromManifest(manifest: unknown): ReportDeliveryBoundaries {
  const effects = (manifest as { effects?: unknown[] })?.effects;
  const boundaries: ReportDeliveryBoundaries = {};
  if (!Array.isArray(effects)) return boundaries;
  for (const effect of effects) {
    if (
      !effect ||
      typeof effect !== "object" ||
      !("step_id" in effect) ||
      typeof effect.step_id !== "string"
    )
      continue;
    const boundary = ReportDeliveryBoundarySchema.safeParse(
      "report_delivery" in effect ? effect.report_delivery : null,
    );
    if (boundary.success) boundaries[effect.step_id] = boundary.data;
  }
  return boundaries;
}
