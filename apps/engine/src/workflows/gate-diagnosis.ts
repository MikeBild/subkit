// Why an approval gate holds a workflow, and what removes it — asked once.
//
// The gate already says what is wrong in four places: the manifest's issues,
// the request and storage refusals beside it, the connectors that cannot
// serve, and — after approval — the step a granted run was refused at. Each
// surface used to read one of them and infer the rest. `diagnoseWorkflow` is
// the single producer: every surface (HTTP, the conversation tools, the
// automation review, the repair queue) reads the same diagnoses, so a remedy
// shown in one place is the remedy proposed in another.
//
// It only reads. Proposing a repair is `proposeGateRepairs` in self-healing;
// this module looks up a candidate that already exists, never creates one.

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
  REPORT_MESSAGE_REFUSALS,
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

/** What kind of act removes the block. `patch` is the only one a fixer can
 *  perform; the others name what a person (or an author) has to do. */
export type GateRemedyKind = "patch" | "prepare" | "declare" | "reconnect" | "author";

export interface GateDiagnosis {
  code: GateDiagnosisCode;
  /** The report gate's own rule the message broke (or how it differs from
   *  its declaration), when the gate named one. */
  reason?: ReportDeliveryRefusal;
  subject: { step_id: string; field?: string };
  evidence: {
    /** The run the diagnosis rests on, when it rests on one. */
    execution_id?: string;
    /** Addresses a successful inspection observed — never message content. */
    observed?: Omit<ReportDeliveryBoundary, "kind">;
  };
  remedy_kind: GateRemedyKind;
  /** Present only when a deterministic fixer computes the repair. It can be
   *  proposed only when the diagnosis `is_current`; on a draft it names the
   *  change to make in the draft. */
  fixer?: GateFixer;
  /** The open repair candidate for this diagnosis, when one was proposed.
   *  Candidates are filed against the active version only, so a draft's
   *  diagnosis never carries one. */
  candidate_id?: string;
}

export interface WorkflowDiagnosis {
  workflow_id: string;
  workflow_version_id: string | null;
  environment: "dev" | "prod";
  /** Whether the diagnosed version is the one runs use. A repair can only be
   *  proposed against the current version — a draft is diagnosed, not fixed. */
  is_current: boolean;
  diagnoses: GateDiagnosis[];
}

/** The wire shape of a diagnosis — the same object every surface returns. */
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

/** A loop body records `send[0]`, `send[1]`, … — the same step. */
const stepKeyOf = (key: string) => key.replace(/\[[0-9]+\]$/, "");
/** The same suffix as a Postgres regular expression. */
const LOOP_SUFFIX = "\\[[0-9]+\\]$";

export function gateEndpointKey(code: string): string {
  return `gate:${code}`;
}

/**
 * Diagnose a workflow's saved version in one environment.
 *
 * The version is the draft when there is one and the current version
 * otherwise — the same choice the automation review makes. `preview` and
 * `held` let a caller that already computed them avoid a second pass.
 */
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
  if (!version) return { ...base, diagnoses: [] };
  const preview = options.preview ?? (await previewWorkflowAuthority(input, db));
  const held =
    options.held !== undefined ? options.held : await inspectHeldPreviewEvidence(input, db);
  const refused = await newestRefusedStep(db, input);
  const diagnoses = collapse(
    await buildDiagnoses(db, { ...input, definition: version.dag, preview, held, refused }),
  );
  // A repair is filed against the active version only (`proposeGateRepair`
  // re-diagnoses that one), so only its diagnosis can point at a candidate.
  if (base.is_current) await attachCandidates(db, input, diagnoses);
  return { ...base, diagnoses };
}

/** The newest step a granted run of exactly this version was refused at and
 *  no later granted run of that version has since got past.
 *  Read from the step row — the run's own record — not from the audit log,
 *  whose reasons sit behind their own read permission. */
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
        // Only the refusal that says the approval no longer fits the
        // materialized request. Other governance refusals (a request outside a
        // declared boundary, an authority that ran out) are not this block and
        // are diagnosed by the preview, not relabelled here.
        sql`${executionSteps.error}->>'code' = 'execution_authority_changed'`,
        // A refusal is history once a later granted run of the same version
        // completed that very step for real: the approval fits again, and
        // naming the old refusal would send a person to repair what works.
        // "Later" is decided in SQL against the refused run's own timestamp —
        // never a JavaScript Date, which drops the microseconds.
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
    // A refusal inside a called workflow is repaired THERE; this workflow can
    // only name the call step that starts it.
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
    // `dynamic_request` is what every refusal above explains in detail; the
    // generic code beside its specific reason would be the same block twice.
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
    const reason = reportRefusalReason(refused.error);
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
            // No rule named: the approval itself no longer fits this version.
            code: "execution_authority_changed",
            subject,
            evidence: { execution_id: refused.execution_id },
            remedy_kind: "prepare",
          },
    );
  }
  return out;
}

/** The operations a diagnosis's fixer computes against a definition, or null
 *  when it has no fixer or the definition no longer supports the fix. */
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

const MESSAGE_REFUSALS: ReadonlySet<string> = new Set(REPORT_MESSAGE_REFUSALS);

/** Refusals a byte-per-character encoder produces and the UTF-8 one removes. */
const ENCODER_REASONS: ReadonlySet<string> = new Set([
  "not_utf8",
  "header_control_byte",
] satisfies ReportMessageRefusal[]);

/** The newest held capture's refusal of the report profile for this step. */
function heldReason(input: DiagnosisInput, step_id: string): ReportMessageRefusal | null {
  const step = input.held?.steps.find((entry) => stepKeyOf(entry.step_id) === step_id);
  const inspection = step?.report_delivery_inspection;
  return inspection && !inspection.ok ? inspection.reason : null;
}

/**
 * What removes a report refusal, decided by its reason.
 *
 * - A message the binary encoder broke: swap the encoder, when exactly one
 *   whole-string reference leads to exactly one encoder call; else author it.
 * - Any other message outside the profile: author it — no fixer guesses MIME.
 * - No message refusal at all (a step no preparation reaches, or a message
 *   addressed differently from its declaration): declare what a successful
 *   inspection of this very step observed, when one was recorded.
 */
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
  if (reason && MESSAGE_REFUSALS.has(reason)) return { evidence, remedy_kind: "author" };
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
      // Unobserved without a recorded reason: the capture predates the
      // recording, or the step never materialized — look at that run.
      if (code === "report_delivery_unobserved" && !reason)
        return {
          code,
          subject,
          evidence: heldRun ? { execution_id: heldRun } : {},
          remedy_kind: "author",
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

/**
 * The newest recorded successful inspection of this very step against the
 * report target, from a held run of exactly the diagnosed version in this
 * environment.
 * The declaration copies what a run observed — never what a transform's
 * source text appears to say.
 */
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
        // Only this version's runs: another version's message may be built
        // and addressed differently, and its observation proves nothing here.
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
    // Only a capture that recorded a successful inspection: a proposal
    // without its verdict predates the recording and proves nothing here.
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

/**
 * One diagnosis per fix. A held preview and a refused granted run can name the
 * same cause under two codes; proposing both would put the same operations in
 * front of a person twice. The first diagnosis wins — the gate's own preview
 * comes before the run evidence — and keeps the run's id when it had none.
 */
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

/**
 * Gate-repair candidates proposed against exactly this version, newest first.
 *
 * Matched by the step and the fixer, not by the gate code: a held preview and
 * a refused granted run name the same cause under different codes, and the
 * repair they call for is one and the same.
 */
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

/** Attach the open gate-repair candidate for each fixable diagnosis. */
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
