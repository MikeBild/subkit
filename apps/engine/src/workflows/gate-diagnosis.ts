import { z } from "@hono/zod-openapi";
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Executor } from "../db/client.ts";
import {
  executionSteps,
  executions,
  patchCandidates,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import type { ManifestIssueCode } from "./effect-manifest.ts";
import { previewWorkflowAuthority } from "./execution-authorities.ts";
import {
  type GateFixer,
  GateFixerSchema,
  type GateFixPlan,
  planReportDeliveryDeclaration,
  planUtf8EncoderFix,
} from "./gate-fix.ts";
import {
  GMAIL_SEND_TARGET,
  isReportMessageRefusal,
  type ReportDeliveryBoundary,
  ReportDeliveryBoundarySchema,
  type ReportDeliveryRefusal,
  ReportDeliveryRefusalSchema,
  type ReportMessageRefusal,
  reportRefusalReason,
} from "./report-delivery-boundary.ts";
import { inspectHeldPreviewEvidence } from "./report-delivery-proposal.ts";
import type { RequestBoundaryRefusal } from "./request-boundary.ts";
import type { StorageBoundaryRefusal } from "./storage-boundary.ts";

export type GateDiagnosisCode =
  | ManifestIssueCode
  | RequestBoundaryRefusal
  | StorageBoundaryRefusal
  | "execution_authority_changed"
  | "connector_unavailable";

export type GateRemedyKind = "patch" | "prepare" | "declare" | "reconnect" | "author";

export interface GateDiagnosis {
  code: GateDiagnosisCode;
  reason?: ReportDeliveryRefusal;
  subject: { step_id: string; field?: string };
  evidence: {
    execution_id?: string;
    observed?: Omit<ReportDeliveryBoundary, "kind">;
  };
  remedy_kind: GateRemedyKind;
  fixer?: GateFixer;
  candidate_id?: string;
}

export interface WorkflowDiagnosis {
  workflow_id: string;
  workflow_version_id: string | null;
  environment: "dev" | "prod";
  is_current: boolean;
  diagnoses: GateDiagnosis[];
}

export const GateDiagnosisSchema = z
  .object({
    code: z.string(),
    reason: ReportDeliveryRefusalSchema.optional(),
    subject: z.object({ step_id: z.string(), field: z.string().optional() }),
    evidence: z.object({
      execution_id: z.string().uuid().optional(),
      observed: z
        .object({
          to: z.string(),
          from: z.string(),
          content_type: ReportDeliveryBoundarySchema.shape.content_type,
        })
        .optional(),
    }),
    remedy_kind: z.enum(["patch", "prepare", "declare", "reconnect", "author"]),
    fixer: GateFixerSchema.optional(),
    candidate_id: z.string().uuid().optional(),
  })
  .openapi("GateDiagnosis");

export const WorkflowDiagnosisSchema = z
  .object({
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid().nullable(),
    environment: z.enum(["dev", "prod"]),
    is_current: z.boolean(),
    diagnoses: z.array(GateDiagnosisSchema),
  })
  .openapi("WorkflowDiagnosis");

type Preview = Awaited<ReturnType<typeof previewWorkflowAuthority>>;
type HeldEvidence = Awaited<ReturnType<typeof inspectHeldPreviewEvidence>>;

const stepKeyOf = (key: string) => key.replace(/\[[0-9]+\]$/, "");
const LOOP_SUFFIX = "\\[[0-9]+\\]$";

export function gateEndpointKey(code: string): string {
  return `gate:${code}`;
}

export async function diagnoseWorkflow(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  environment: "dev" | "prod",
  options: { version_id?: string; preview?: Preview; held?: HeldEvidence } = {},
): Promise<WorkflowDiagnosis | null> {
  const [workflow] = await db
    .select({
      current_version_id: workflows.current_version_id,
      draft_version_id: workflows.draft_version_id,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  if (!workflow) return null;
  const version_id =
    options.version_id ?? workflow.draft_version_id ?? workflow.current_version_id ?? null;
  const base = {
    workflow_id,
    workflow_version_id: version_id,
    environment,
    is_current: version_id !== null && version_id === workflow.current_version_id,
  };
  if (!version_id) return { ...base, diagnoses: [] };
  const input = {
    tenant_id,
    workflow_id,
    workflow_version_id: version_id,
    execution_environment: environment,
  };
  const [version] = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, tenant_id),
        eq(workflowVersions.workflow_id, workflow_id),
        eq(workflowVersions.id, version_id),
      ),
    )
    .limit(1);
  if (!version) return options.version_id ? null : { ...base, diagnoses: [] };
  const preview = options.preview ?? (await previewWorkflowAuthority(input, db));
  const held =
    options.held !== undefined ? options.held : await inspectHeldPreviewEvidence(input, db);
  const refused = await newestRefusedStep(db, input);
  const diagnoses = collapse(
    await buildDiagnoses(db, { ...input, definition: version.dag, preview, held, refused }),
  );
  if (base.is_current) await attachCandidates(db, input, diagnoses);
  return { ...base, diagnoses };
}

async function newestRefusedStep(
  db: Executor,
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
  },
) {
  const laterStep = alias(executionSteps, "later_step");
  const laterRun = alias(executions, "later_run");
  const [row] = await db
    .select({
      execution_id: executionSteps.execution_id,
      step_key: executionSteps.step_key,
      error: executionSteps.error,
    })
    .from(executionSteps)
    .innerJoin(
      executions,
      and(
        eq(executions.id, executionSteps.execution_id),
        eq(executions.tenant_id, executionSteps.tenant_id),
      ),
    )
    .where(
      and(
        eq(executionSteps.tenant_id, input.tenant_id),
        eq(executions.workflow_id, input.workflow_id),
        eq(executions.workflow_version_id, input.workflow_version_id),
        eq(executions.execution_mode, input.execution_environment),
        isNotNull(executions.execution_authority_id),
        sql`${executionSteps.error}->>'code' = 'execution_authority_changed'`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(laterStep)
            .innerJoin(
              laterRun,
              and(
                eq(laterRun.id, laterStep.execution_id),
                eq(laterRun.tenant_id, laterStep.tenant_id),
              ),
            )
            .where(
              and(
                eq(laterStep.tenant_id, executionSteps.tenant_id),
                eq(laterRun.workflow_id, executions.workflow_id),
                eq(laterRun.workflow_version_id, executions.workflow_version_id),
                eq(laterRun.execution_mode, executions.execution_mode),
                isNotNull(laterRun.execution_authority_id),
                eq(laterRun.hold_writes, false),
                ne(laterRun.id, executions.id),
                gt(laterRun.created_at, executions.created_at),
                eq(laterStep.status, "succeeded"),
                eq(laterStep.held, false),
                sql`regexp_replace(${laterStep.step_key}, ${LOOP_SUFFIX}, '') = regexp_replace(${executionSteps.step_key}, ${LOOP_SUFFIX}, '')`,
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(executions.created_at), desc(executionSteps.started_at))
    .limit(1);
  if (!row) return null;
  return { execution_id: row.execution_id, step_id: stepKeyOf(row.step_key), error: row.error };
}

interface DiagnosisInput {
  tenant_id: string;
  workflow_id: string;
  workflow_version_id: string;
  execution_environment: "dev" | "prod";
  definition: unknown;
  preview: Preview;
  held: HeldEvidence;
  refused: Awaited<ReturnType<typeof newestRefusedStep>>;
}

async function buildDiagnoses(db: Executor, input: DiagnosisInput): Promise<GateDiagnosis[]> {
  const { preview, refused } = input;
  const out: GateDiagnosis[] = [];
  const refusedSteps = new Set<string>();
  for (const refusal of preview.request_refusals) {
    const step_id = refusal.call_path?.[0] ?? refusal.step_id;
    refusedSteps.add(step_id);
    if (refusal.call_path) {
      out.push({ code: refusal.reason, subject: { step_id }, evidence: {}, remedy_kind: "author" });
      continue;
    }
    out.push(await requestDiagnosis(db, input, refusal.step_id, refusal.reason));
  }
  for (const refusal of preview.storage_refusals) {
    const step_id = refusal.call_path?.[0] ?? refusal.step_id;
    refusedSteps.add(step_id);
    out.push({ code: refusal.reason, subject: { step_id }, evidence: {}, remedy_kind: "author" });
  }
  for (const issue of preview.manifest.issues) {
    if (issue.code === "dynamic_request" && refusedSteps.has(issue.step_id)) continue;
    out.push({
      code: issue.code,
      subject: { step_id: issue.step_id },
      evidence: {},
      remedy_kind: "author",
    });
  }
  for (const connector of preview.unavailable_connectors) {
    out.push({
      code: "connector_unavailable",
      subject: { step_id: connector.step_id },
      evidence: {},
      remedy_kind: "reconnect",
    });
  }
  if (refused) {
    const reason = reportRefusalReason(refused.error) ?? heldReason(input, refused.step_id);
    const subject = { step_id: refused.step_id };
    out.push(
      reason
        ? {
            code: "execution_authority_changed",
            reason,
            subject,
            ...(await reportRemedy(db, input, refused.step_id, reason, refused.execution_id)),
          }
        : {
            code: "execution_authority_changed",
            subject,
            evidence: { execution_id: refused.execution_id },
            remedy_kind: heldInspected(input, refused.step_id) ? "author" : "prepare",
          },
    );
  }
  return out;
}

export function planForDiagnosis(
  definition: unknown,
  diagnosis: GateDiagnosis,
): GateFixPlan | null {
  if (diagnosis.fixer === "use_utf8_encoder")
    return planUtf8EncoderFix(definition, diagnosis.subject.step_id);
  if (diagnosis.fixer === "declare_report_delivery" && diagnosis.evidence.observed)
    return planReportDeliveryDeclaration(
      definition,
      diagnosis.subject.step_id,
      diagnosis.evidence.observed,
    );
  return null;
}

const ENCODER_REASONS: ReadonlySet<string> = new Set([
  "not_utf8",
  "header_control_byte",
] satisfies ReportMessageRefusal[]);

function heldInspected(input: DiagnosisInput, step_id: string): boolean {
  const step = input.held?.steps.find((entry) => stepKeyOf(entry.step_id) === step_id);
  return step?.report_delivery_inspection !== undefined;
}

function heldReason(input: DiagnosisInput, step_id: string): ReportMessageRefusal | null {
  const step = input.held?.steps.find((entry) => stepKeyOf(entry.step_id) === step_id);
  const inspection = step?.report_delivery_inspection;
  return inspection && !inspection.ok ? inspection.reason : null;
}

async function reportRemedy(
  db: Executor,
  input: DiagnosisInput,
  step_id: string,
  reason: ReportDeliveryRefusal | null,
  execution_id: string | undefined,
): Promise<Pick<GateDiagnosis, "evidence" | "remedy_kind" | "fixer">> {
  const evidence = execution_id ? { execution_id } : {};
  if (reason && ENCODER_REASONS.has(reason))
    return planUtf8EncoderFix(input.definition, step_id)
      ? { evidence, remedy_kind: "patch", fixer: "use_utf8_encoder" }
      : { evidence, remedy_kind: "author" };
  if (isReportMessageRefusal(reason)) return { evidence, remedy_kind: "author" };
  const observation = await successfulObservation(db, input, step_id);
  const plan = observation
    ? planReportDeliveryDeclaration(input.definition, step_id, observation.observed)
    : null;
  return plan && observation
    ? {
        evidence: { execution_id: observation.execution_id, observed: observation.observed },
        remedy_kind: "declare",
        fixer: "declare_report_delivery",
      }
    : { evidence, remedy_kind: "declare" };
}

async function requestDiagnosis(
  db: Executor,
  input: DiagnosisInput,
  step_id: string,
  code: RequestBoundaryRefusal,
): Promise<GateDiagnosis> {
  const subject = { step_id };
  const heldRun = input.held ? input.held.execution_id : undefined;
  switch (code) {
    case "report_delivery_unprepared":
      return { code, subject, evidence: {}, remedy_kind: "prepare" };
    case "report_delivery_unreachable":
      return { code, subject, ...(await reportRemedy(db, input, step_id, null, undefined)) };
    case "report_delivery_unobserved":
    case "report_delivery_contradicted": {
      const reason = heldReason(input, step_id);
      if (code === "report_delivery_unobserved" && !reason)
        return {
          code,
          subject,
          evidence: heldRun ? { execution_id: heldRun } : {},
          remedy_kind: heldInspected(input, step_id) ? "author" : "prepare",
        };
      return {
        code,
        ...(reason ? { reason } : {}),
        subject,
        ...(await reportRemedy(db, input, step_id, reason, heldRun)),
      };
    }
    default:
      return { code, subject, evidence: {}, remedy_kind: "author" };
  }
}

async function successfulObservation(db: Executor, input: DiagnosisInput, step_id: string) {
  const rows = await db
    .select({
      execution_id: executionSteps.execution_id,
      step_key: executionSteps.step_key,
      meta: executionSteps.request_meta,
    })
    .from(executionSteps)
    .innerJoin(
      executions,
      and(
        eq(executions.id, executionSteps.execution_id),
        eq(executions.tenant_id, executionSteps.tenant_id),
      ),
    )
    .where(
      and(
        eq(executionSteps.tenant_id, input.tenant_id),
        eq(executions.workflow_id, input.workflow_id),
        eq(executions.workflow_version_id, input.workflow_version_id),
        eq(executions.execution_mode, input.execution_environment),
        eq(executions.hold_writes, true),
        sql`(${executionSteps.step_key} = ${step_id} OR ${executionSteps.step_key} ~ ${`^${escapeRegex(step_id)}\\[[0-9]+\\]$`})`,
      ),
    )
    .orderBy(desc(executions.created_at), desc(executionSteps.started_at))
    .limit(20);
  for (const row of rows) {
    const meta = row.meta as {
      url?: unknown;
      extras?: {
        held?: boolean;
        report_delivery_proposal?: unknown;
        report_delivery_inspection?: { ok?: unknown };
      };
    } | null;
    if (
      meta?.extras?.held !== true ||
      meta.url !== GMAIL_SEND_TARGET ||
      meta.extras.report_delivery_inspection?.ok !== true
    )
      continue;
    const observed = ReportDeliveryBoundarySchema.safeParse(meta.extras.report_delivery_proposal);
    if (!observed.success) continue;
    const { to, from, content_type } = observed.data;
    return { execution_id: row.execution_id, observed: { to, from, content_type } };
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapse(diagnoses: GateDiagnosis[]): GateDiagnosis[] {
  const byFix = new Map<string, GateDiagnosis>();
  const seen = new Set<string>();
  const out: GateDiagnosis[] = [];
  for (const diagnosis of diagnoses) {
    const identity = `${diagnosis.subject.step_id}\u0000${diagnosis.code}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (diagnosis.fixer) {
      const key = `${diagnosis.subject.step_id}\u0000${diagnosis.fixer}`;
      const kept = byFix.get(key);
      if (kept) {
        if (!kept.evidence.execution_id && diagnosis.evidence.execution_id)
          kept.evidence.execution_id = diagnosis.evidence.execution_id;
        continue;
      }
      byFix.set(key, diagnosis);
    }
    out.push(diagnosis);
  }
  return out;
}

export async function findGateCandidate(
  db: Executor,
  input: { tenant_id: string; workflow_id: string; workflow_version_id: string },
  match: { step_id: string; fixer: GateFixer },
  statuses: ReadonlyArray<"proposed" | "applied" | "rejected" | "superseded" | "inapplicable">,
) {
  const rows = await db
    .select({ id: patchCandidates.id, status: patchCandidates.status, diff: patchCandidates.diff })
    .from(patchCandidates)
    .where(
      and(
        eq(patchCandidates.tenant_id, input.tenant_id),
        eq(patchCandidates.workflow_id, input.workflow_id),
        inArray(patchCandidates.status, [...statuses]),
        sql`${patchCandidates.endpoint_key} LIKE 'gate:%'`,
        sql`${patchCandidates.diff}->>'base_version_id' = ${input.workflow_version_id}`,
      ),
    )
    .orderBy(desc(patchCandidates.created_at), desc(patchCandidates.id));
  return (
    rows.find((row) => {
      const signal = (
        row.diff as { drift_signal?: { kind?: unknown; step_id?: unknown; fixer?: unknown } } | null
      )?.drift_signal;
      return (
        signal?.kind === "gate_block" &&
        signal.step_id === match.step_id &&
        signal.fixer === match.fixer
      );
    }) ?? null
  );
}

async function attachCandidates(
  db: Executor,
  input: { tenant_id: string; workflow_id: string; workflow_version_id: string },
  diagnoses: GateDiagnosis[],
) {
  for (const diagnosis of diagnoses) {
    if (!diagnosis.fixer) continue;
    const open = await findGateCandidate(
      db,
      input,
      { step_id: diagnosis.subject.step_id, fixer: diagnosis.fixer },
      ["proposed"],
    );
    if (open) diagnosis.candidate_id = open.id;
  }
}
