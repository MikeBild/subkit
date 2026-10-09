import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { executionSteps, executions, workflowExecutionAuthorities } from "../db/schema/index.ts";
import {
  assertHistoryVersion,
  historyScopeKey,
  type WorkflowHistoryFacts,
} from "./history-read-facts.ts";
import {
  REPORT_MESSAGE_REFUSALS,
  type ReportDeliveryBoundary,
  ReportDeliveryBoundarySchema,
  type ReportDeliveryInspectionRecord,
  type ReportMessageRefusal,
} from "./report-delivery-boundary.ts";

export type ReportDeliveryBoundaries = Record<string, ReportDeliveryBoundary>;

export type ReportDeliveryObservation =
  | { ok: true; boundary: ReportDeliveryBoundary }
  | { ok: false; reason: ReportMessageRefusal };

export interface ReportDeliveryEvidence {
  boundaries: ReportDeliveryBoundaries;
  prepared?: boolean;
  reached?: ReadonlySet<string>;
  inspections?: ReadonlyMap<string, ReadonlyArray<ReportDeliveryObservation>>;
}

const InspectionRecordSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(REPORT_MESSAGE_REFUSALS) }).strict(),
]);

function recordedInspection(extras: unknown): ReportDeliveryInspectionRecord | null {
  const parsed = InspectionRecordSchema.safeParse(
    (extras as { report_delivery_inspection?: unknown } | undefined)?.report_delivery_inspection,
  );
  return parsed.success ? parsed.data : null;
}

export async function inspectHeldPreviewEvidence(
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
  },
  db: Executor,
  facts?: WorkflowHistoryFacts,
) {
  if (facts) assertHistoryVersion(facts, input);
  const run = facts
    ? facts.held.get(historyScopeKey(input))
    : (
        await db
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
          .limit(1)
      )[0];
  if (!run) return null;
  const steps = facts
    ? (facts.steps.get(run.id) ?? []).map((step) => ({
        step_id: step.key,
        status: step.status,
        meta: step.meta,
      }))
    : await db
        .select({
          step_id: executionSteps.step_key,
          status: executionSteps.status,
          meta: executionSteps.request_meta,
        })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.tenant_id, input.tenant_id),
            eq(executionSteps.execution_id, run.id),
          ),
        );
  return {
    execution_id: run.id,
    status: run.status,
    steps: steps.map(({ step_id, status, meta }) => {
      const extras = (
        meta as { extras?: { held?: boolean; report_delivery_proposal?: unknown } } | null
      )?.extras;
      const inspection = extras?.held === true ? recordedInspection(extras) : null;
      return {
        step_id,
        status,
        held: extras?.held === true,
        report_boundary_observed: ReportDeliveryBoundarySchema.safeParse(
          extras?.report_delivery_proposal,
        ).success,
        ...(inspection ? { report_delivery_inspection: inspection } : {}),
      };
    }),
  };
}

export async function proposeReportDeliveryBoundaries(
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
  },
  db: Executor,
  facts?: WorkflowHistoryFacts,
): Promise<ReportDeliveryEvidence> {
  if (facts) assertHistoryVersion(facts, input);
  const authority = facts
    ? facts.authorities.get(historyScopeKey(input))
    : (
        await db
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
          .orderBy(
            desc(workflowExecutionAuthorities.created_at),
            desc(workflowExecutionAuthorities.id),
          )
          .limit(1)
      )[0];
  if (authority) return { boundaries: reportBoundariesFromManifest(authority.manifest) };
  const run = facts
    ? facts.held.get(historyScopeKey(input))
    : (
        await db
          .select({ id: executions.id })
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
          .limit(1)
      )[0];
  if (!run)
    return { boundaries: {}, prepared: false, reached: new Set<string>(), inspections: new Map() };
  const steps = facts
    ? (facts.steps.get(run.id) ?? [])
    : await db
        .select({
          key: executionSteps.step_key,
          status: executionSteps.status,
          meta: executionSteps.request_meta,
        })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.tenant_id, input.tenant_id),
            eq(executionSteps.execution_id, run.id),
          ),
        );
  const boundaries: ReportDeliveryBoundaries = {};
  const reached = new Set<string>();
  const inspections = new Map<string, ReportDeliveryObservation[]>();
  for (const step of steps) {
    const key = step.key.replace(/\[[0-9]+\]$/, "");
    if (step.status === "succeeded") reached.add(key);
    const metadata = step.meta as {
      extras?: { held?: boolean; report_delivery_proposal?: unknown };
    } | null;
    const proposal = ReportDeliveryBoundarySchema.safeParse(
      metadata?.extras?.report_delivery_proposal,
    );
    if (metadata?.extras?.held === true && proposal.success) boundaries[key] = proposal.data;
    const inspection = metadata?.extras?.held === true ? recordedInspection(metadata.extras) : null;
    const observation: ReportDeliveryObservation | null = !inspection
      ? null
      : !inspection.ok
        ? inspection
        : proposal.success
          ? { ok: true, boundary: proposal.data }
          : null;
    if (observation) inspections.set(key, [...(inspections.get(key) ?? []), observation]);
  }
  return { boundaries, prepared: true, reached, inspections };
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
