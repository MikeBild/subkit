import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { HttpError } from "../../http/errors.ts";
import { PatchProposalSchema } from "../../llm/flows/repair.ts";
import {
  approveReviewedPatchCandidate,
  findPatchCandidate,
  getPatchCandidateWithWorkflow,
  listPatchCandidatesWithWorkflow,
  type PatchCandidateRow,
  readPatchInteractionLog,
} from "../../self-healing/candidate-admin.ts";
import { PatchDecisionError, rejectPatchCandidate } from "../../self-healing/candidate-decision.ts";
import {
  PatchReadinessSchema,
  readPatchReadiness,
  readPatchReadinessBatch,
} from "../../self-healing/candidate-readiness.ts";
import {
  dryRunPatchCandidate,
  previewPatchCandidate,
} from "../../self-healing/candidate-review.ts";
import { readOpenPatchDecisions } from "../../self-healing/open-decisions.ts";
import { preparePatchCandidate } from "../../self-healing/prepare-candidate.ts";
import { GrantWorkflowAuthoritySchema } from "../../workflows/execution-authorities.ts";
import { ReportDeliveryBoundarySchema } from "../../workflows/report-delivery-boundary.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, type Rejection, reject } from "./index.ts";

const PatchStatusSchema = z.enum(["proposed", "applied", "rejected", "superseded", "inapplicable"]);

const AcceptedOperations = z.array(z.number().int().min(0)).min(1).max(500);

const PatchOperationSchema = z
  .object({
    index: z.number().int().min(0),
    path: z.string(),
    line: z.number().int().positive().nullable(),
    change: z.enum(["added", "removed", "changed"]),
    before: z.unknown(),
    after: z.unknown(),
    description_key: z.string(),
  })
  .openapi("PatchOperation");

const PatchInteractionSchema = z
  .object({
    at: z.string(),
    event: z.enum(["tested", "accepted", "accepted_partly", "declined"]),
    actor_type: z.string(),
    actor_id: z.string().nullable(),
    ok: z.boolean().nullable(),
    accepted_operations: z.array(z.number().int()).nullable(),
    declined_operations: z.array(z.number().int()).nullable(),
    reason: z.string().nullable(),
  })
  .openapi("PatchInteraction");

const PatchCandidateSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    workflow_id: z.string(),
    workflow_name: z.string().nullable(),
    connector_id: z.string().nullable(),
    endpoint_key: z.string().nullable(),
    classification: z.enum(["safe", "unsafe"]),
    status: PatchStatusSchema,
    fixture_id: z.string().nullable(),
    diff: z.unknown(),
    closed_reason: z.string().nullable(),
    closed_against_version_id: z.string().nullable(),
    closed_at: z.string().nullable(),
    accepted_operations: z.array(z.number().int()).nullable(),
    accepted_digest: z.string().nullable(),
    interaction_log: z.array(PatchInteractionSchema).optional(),
    created_at: z.string(),
    updated_at: z.string(),
    ...PatchReadinessSchema.partial().shape,
  })
  .openapi("PatchCandidate");

const ListResponse = z
  .object({
    items: z.array(PatchCandidateSchema),
    total: z.number().int().min(0),
    reviewable_total: z.number().int().min(0),
  })
  .openapi("PatchCandidateListResponse");

const ListQuery = z
  .object({
    status: PatchStatusSchema.optional(),
    workflow_id: z.string().uuid().optional(),
    reviewable: z.enum(["true", "false"]).optional(),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().positive().max(200).optional(),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .openapi("ListPatchCandidatesQuery");

const StepShapeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["request", "transform"]),
    data_selector: z.string().optional(),
    expression: z.string().optional(),
    report_delivery: ReportDeliveryBoundarySchema.optional(),
  })
  .openapi("PatchCandidateStepShape");

const PreviewResponse = z
  .object({
    candidate_id: z.string(),
    workflow_id: z.string(),
    classification: z.enum(["safe", "unsafe"]),
    status: PatchStatusSchema,
    drift_summary: z.string().nullable(),
    proposal: PatchProposalSchema.nullable(),
    fixture_available: z.boolean(),
    proposal_dry_run: z.record(z.string(), z.unknown()).nullable(),
    before_step: StepShapeSchema.nullable(),
    after_step: StepShapeSchema.nullable(),
    changed_paths: z.array(z.string()),
    operations: z.array(PatchOperationSchema),
    accepted_operations: z.array(z.number().int()).nullable(),
    accepted_digest: z.string().nullable(),
    ...PatchReadinessSchema.shape,
  })
  .openapi("PatchCandidatePreview");

const PrepareBody = z.object({
  expected_review_digest: z.string().regex(/^[a-f0-9]{64}$/),
  accepted_operations: AcceptedOperations.optional(),
});

const ApproveBody = z
  .object({
    expected_review_digest: z.string().regex(/^[a-f0-9]{64}$/),
    accepted_operations: AcceptedOperations.optional(),
    execution_authority: GrantWorkflowAuthoritySchema.optional(),
  })
  .openapi("ApprovePatchCandidateBody");

const DryRunBody = z
  .object({ accepted_operations: AcceptedOperations.optional() })
  .openapi("DryRunPatchCandidateBody");

const RejectBody = z.object({ reason: z.string().optional() }).openapi("RejectPatchCandidateBody");

const DryRunResponse = z
  .object({
    ok: z.boolean(),
    error: z.string().nullable(),
    value_preview: z.unknown(),
    fixture_source: z.enum(["recorded", "synthesized"]),
    accepted_operations: z.array(z.number().int()).nullable(),
    review_digest: z.string().nullable(),
  })
  .openapi("PatchCandidateDryRunResponse");

const SESSION_BOUNDARY_CODES = [
  "human_session_required",
  "human_session_expired",
  "csrf_rejected",
  "authority_permission_denied",
];

type ListInput = z.infer<typeof ListQuery>;
type Readiness = Awaited<ReturnType<typeof readPatchReadiness>>;
type Preview = NonNullable<Awaited<ReturnType<typeof previewPatchCandidate>>>;
type Prepared = Awaited<ReturnType<typeof preparePatchCandidate>>;
type DryRun = Extract<Awaited<ReturnType<typeof dryRunPatchCandidate>>, { status: "ran" }>;
type ApproveFields = z.infer<typeof ApproveBody>;

interface IdInput {
  readonly id: string;
}

interface PrepareInput extends IdInput {
  readonly expected_review_digest: string;
  readonly accepted_operations?: number[] | undefined;
}

interface DryRunInput extends IdInput {
  readonly accepted_operations?: number[] | undefined;
}

interface ApproveInput extends IdInput {
  readonly body: ApproveFields;
}

interface RejectInput extends IdInput {
  readonly reason?: string | undefined;
}

interface ReviewedCandidate {
  readonly candidate: PatchCandidateRow;
  readonly workflow_name: string | null;
  readonly readiness: Readiness;
  readonly interaction_log?: Awaited<ReturnType<typeof readPatchInteractionLog>>;
}

interface ListResult {
  readonly items: ReviewedCandidate[];
  readonly total: number;
  readonly reviewable_total: number;
}

function serialize({
  candidate: row,
  workflow_name,
  readiness,
  interaction_log,
}: ReviewedCandidate) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    workflow_name,
    connector_id: row.connector_id ?? null,
    endpoint_key: row.endpoint_key ?? null,
    classification: row.classification,
    status: row.status,
    fixture_id: row.fixture_id ?? null,
    diff: row.diff,
    closed_reason: row.closed_reason ?? null,
    closed_against_version_id: row.closed_against_version_id ?? null,
    closed_at: row.closed_at?.toISOString() ?? null,
    accepted_operations: row.accepted_operations ?? null,
    accepted_digest: row.accepted_digest ?? null,
    ...(interaction_log ? { interaction_log } : {}),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    ...readiness,
  };
}

function idFrom(param: unknown): IdInput {
  return { id: (param as IdInput).id };
}

export const preparePatchCandidateOperation = defineOperation<PrepareInput, Prepared>({
  id: "patch_candidate.prepare",
  summary: "Prepare an immutable repaired version without activation or execution authority",
  permission: "workflow:write",
  effect: "write",
  audit: AuditAction.PATCH_CANDIDATE_PREPARED,
  async handler(scope, input) {
    if (!scope.principal) return reject.unauthorized();
    try {
      return await preparePatchCandidate(
        {
          tenant_id: scope.tenant_id,
          actor_id: scope.principal.id,
          actor_type: scope.principal.kind,
          candidate_id: input.id,
          expected_review_digest: input.expected_review_digest,
          accepted_operations: input.accepted_operations,
        },
        scope.db,
      );
    } catch (error) {
      if (error instanceof PatchDecisionError)
        return reject.conflict("The repair preview is no longer applicable", undefined, error.code);
      throw error;
    }
  },
  http: {
    method: "post",
    path: "/v1/patch-candidates/{id}/prepare",
    tags: ["patch-candidates"],
    params: IdParam,
    body: PrepareBody,
    response: z.object({ workflow_version_id: z.string(), review_digest: z.string() }),
    success: { status: 200, description: "Prepared" },
    errors: { 409: "Review changed" },
    toInput: ({ param, json }) => ({
      ...idFrom(param),
      expected_review_digest: (json as z.infer<typeof PrepareBody>).expected_review_digest,
      accepted_operations: (json as z.infer<typeof PrepareBody>).accepted_operations,
    }),
    toBody: (prepared) => prepared,
  },
});

export const listPatchCandidatesOperation = defineOperation<ListInput, ListResult>({
  id: "patch_candidate.list",
  summary: "List patch candidates",
  permission: "workflow:read",
  effect: "read",
  async handler(scope, q) {
    const rows = await listPatchCandidatesWithWorkflow(scope.db, scope.tenant_id, {
      status: q.status,
      workflow_id: q.workflow_id,
      order: q.order,
    });
    const readiness = await readPatchReadinessBatch(
      scope.tenant_id,
      rows.map((row) => row.candidate),
      scope.db,
    );
    const items = rows.map((row, index) => ({
      candidate: row.candidate,
      workflow_name: row.workflow_name,
      readiness: readiness[index] as Readiness,
    }));
    const filtered =
      q.reviewable === undefined
        ? items
        : items.filter((item) => item.readiness.reviewable === (q.reviewable === "true"));
    const open = await readOpenPatchDecisions(scope.db, scope.tenant_id, {
      ...(q.workflow_id ? { workflow_id: q.workflow_id } : {}),
      limit: 0,
    });
    return {
      items: filtered.slice(q.offset, q.offset + (q.limit ?? 50)),
      total: filtered.length,
      reviewable_total: open.open_total,
    };
  },
  http: {
    method: "get",
    path: "/v1/patch-candidates",
    tags: ["patch-candidates"],
    query: ListQuery,
    response: ListResponse,
    toInput: ({ query }) => query as ListInput,
    toBody: ({ items, total, reviewable_total }) => ({
      items: items.map(serialize),
      total,
      reviewable_total,
    }),
  },
});

export const getPatchCandidateOperation = defineOperation<IdInput, ReviewedCandidate>({
  id: "patch_candidate.get",
  summary: "Fetch a patch candidate",
  permission: "workflow:read",
  effect: "read",
  async handler(scope, { id }) {
    const row = await getPatchCandidateWithWorkflow(scope.db, scope.tenant_id, id);
    if (!row) return reject.notFound("patch_candidate");
    return {
      candidate: row.candidate,
      workflow_name: row.workflow_name,
      readiness: await readPatchReadiness(scope.tenant_id, row.candidate, scope.db),
      interaction_log: await readPatchInteractionLog(scope.db, scope.tenant_id, id),
    };
  },
  http: {
    method: "get",
    path: "/v1/patch-candidates/{id}",
    tags: ["patch-candidates"],
    params: IdParam,
    response: PatchCandidateSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: serialize,
  },
});

export const previewPatchCandidateOperation = defineOperation<IdInput, Preview>({
  id: "patch_candidate.preview",
  summary: "Human-readable before/after preview of a patch candidate",
  permission: "workflow:read",
  effect: "read",
  async handler(scope, { id }) {
    return (
      (await previewPatchCandidate(scope.tenant_id, id, scope.db)) ??
      reject.notFound("patch_candidate")
    );
  },
  http: {
    method: "get",
    path: "/v1/patch-candidates/{id}/preview",
    tags: ["patch-candidates"],
    params: IdParam,
    response: PreviewResponse,
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: (preview) => preview,
  },
});

function notProposed(row: PatchCandidateRow, decision: string, hint: string): Rejection {
  return reject.status(
    409,
    "conflict",
    `patch candidate is ${row.status}; only 'proposed' candidates can be ${decision}`,
    undefined,
    hint,
  );
}

function approvalRejection(error: unknown): Rejection {
  if (error instanceof PatchDecisionError)
    return reject.status(
      409,
      error.code,
      "The reviewed repair cannot be applied",
      undefined,
      "Load the candidate preview to inspect its current state and reason.",
    );
  if (error instanceof HttpError) throw error;
  const code = (error as { code?: string }).code;
  if (!code) throw error;
  return reject.status(
    SESSION_BOUNDARY_CODES.includes(code) ? 403 : 409,
    code,
    "The reviewed execution boundary could not be granted",
  );
}

export const dryRunPatchCandidateOperation = defineOperation<DryRunInput, DryRun>({
  id: "patch_candidate.dry_run",
  summary: "Replay a patch candidate against a recorded or synthesized fixture",
  permission: "workflow:read",
  effect: "write",
  audit: AuditAction.PATCH_CANDIDATE_DRY_RUN_REQUESTED,
  async handler(scope, { id, accepted_operations }) {
    if (!scope.principal) return reject.unauthorized();
    const outcome = await dryRunPatchCandidate(
      {
        tenant_id: scope.tenant_id,
        candidate_id: id,
        actor_id: scope.principal.id,
        actor_type: scope.principal.kind,
        accepted_operations,
      },
      scope.db,
    );
    if (outcome.status === "not_found") return reject.notFound("patch_candidate");
    if (outcome.status === "invalid_selection")
      return reject.status(
        409,
        outcome.reason,
        "the selected operations cannot be tested",
        undefined,
        "load the candidate preview and pass indices from its `operations` list",
      );
    if (outcome.status === "no_proposal" || outcome.status === "no_step")
      return reject.status(
        409,
        "conflict",
        "patch candidate carries no replayable step material",
        undefined,
        "this candidate came from a proactive scan with no failing-step snapshot — run the workflow once so the engine captures one, then re-scan",
      );
    if (outcome.status === "gate_fix")
      return reject.status(
        409,
        "not_replayable",
        "a gate repair has no fixture replay",
        undefined,
        "prepare the candidate (POST /v1/patch-candidates/{id}/prepare) and let a held preparation run of the prepared version show the request the gate now sees",
      );
    if (outcome.status === "no_fixture")
      return reject.status(
        409,
        "conflict",
        "no execution fixture to replay against",
        undefined,
        "run the workflow once so the engine captures a fixture, then retry the dry-run",
      );
    return outcome;
  },
  http: {
    method: "post",
    path: "/v1/patch-candidates/{id}/dry-run",
    tags: ["patch-candidates"],
    description:
      "Never mutates the candidate's status — this is a pre-approval check. Uses the fixture recorded at proposal time, or synthesizes one from the failing step's persisted request/response material.",
    params: IdParam,
    body: DryRunBody,
    bodyRequired: false,
    response: DryRunResponse,
    success: { status: 200, description: "Dry-run ran" },
    errors: { 404: "Not found", 409: "No fixture / step material to replay against" },
    toInput: ({ param, json }) => ({
      ...idFrom(param),
      accepted_operations: (json as z.infer<typeof DryRunBody> | undefined)?.accepted_operations,
    }),
    toBody: (outcome) => ({
      ok: outcome.ok,
      error: outcome.error,
      value_preview: outcome.value_preview,
      fixture_source: outcome.fixture_source,
      accepted_operations: outcome.accepted_operations,
      review_digest: outcome.review_digest,
    }),
  },
});

export const approvePatchCandidateOperation = defineOperation<ApproveInput, string>({
  id: "patch_candidate.approve",
  summary: "Approve and apply a patch candidate",
  permission: "workflow:write",
  effect: "write",
  audit: AuditAction.PATCH_CANDIDATE_APPROVED,
  async handler(scope, { id, body }) {
    if (!scope.principal || !scope.request) return reject.unauthorized();
    const row = await findPatchCandidate(scope.db, scope.tenant_id, id);
    if (!row) return reject.notFound("patch_candidate");
    if (row.status !== "proposed")
      return notProposed(
        row,
        "approved",
        "the candidate already reached a terminal status — a fresh drift scan may have superseded it; subkit patch-candidates list shows what is still open",
      );
    let versionId: string | null;
    try {
      versionId = await approveReviewedPatchCandidate(scope.db, {
        principal: scope.principal,
        request: scope.request,
        candidate: row,
        expected_review_digest: body.expected_review_digest,
        accepted_operations: body.accepted_operations,
        execution_authority: body.execution_authority,
      });
    } catch (error) {
      return approvalRejection(error);
    }
    return (
      versionId ?? reject.conflict("Candidate is no longer proposed", undefined, "already_decided")
    );
  },
  http: {
    method: "post",
    path: "/v1/patch-candidates/{id}/approve",
    tags: ["patch-candidates"],
    params: IdParam,
    body: ApproveBody,
    response: z.object({ applied: z.boolean(), workflow_version_id: z.string().nullable() }),
    success: { status: 200, description: "Applied" },
    errors: { 404: "Not found", 409: "Conflict" },
    toInput: ({ param, json }) => ({ ...idFrom(param), body: json as ApproveFields }),
    toBody: (versionId) => ({ applied: true, workflow_version_id: versionId }),
  },
});

export const rejectPatchCandidateOperation = defineOperation<RejectInput, { rejected: boolean }>({
  id: "patch_candidate.reject",
  summary: "Reject a patch candidate",
  permission: "workflow:write",
  effect: "write",
  audit: AuditAction.PATCH_CANDIDATE_REJECTED,
  async handler(scope, { id, reason }) {
    if (!scope.principal) return reject.unauthorized();
    const row = await findPatchCandidate(scope.db, scope.tenant_id, id);
    if (!row) return reject.notFound("patch_candidate");
    if (row.status !== "proposed")
      return notProposed(
        row,
        "rejected",
        "the candidate already reached a terminal status — nothing to do; subkit patch-candidates list shows what is still open",
      );
    const rejected = await rejectPatchCandidate(
      {
        tenant_id: scope.tenant_id,
        candidate_id: id,
        actor_id: scope.principal.id,
        actor_type: scope.principal.kind,
        ...(reason ? { reason } : {}),
      },
      scope.db,
    );
    return { rejected };
  },
  http: {
    method: "post",
    path: "/v1/patch-candidates/{id}/reject",
    tags: ["patch-candidates"],
    params: IdParam,
    body: RejectBody,
    response: z.object({ rejected: z.boolean() }),
    success: { status: 200, description: "Rejected" },
    errors: { 404: "Not found", 409: "Conflict" },
    toInput: ({ param, json }) => ({
      ...idFrom(param),
      reason: (json as z.infer<typeof RejectBody>).reason,
    }),
    toBody: (result) => result,
  },
});
