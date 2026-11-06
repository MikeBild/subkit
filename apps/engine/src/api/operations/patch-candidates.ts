import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { PatchProposalSchema } from "../../llm/flows/repair.ts";
import {
  getPatchCandidateWithWorkflow,
  listPatchCandidatesWithWorkflow,
  type PatchCandidateRow,
} from "../../self-healing/candidate-admin.ts";
import { PatchDecisionError } from "../../self-healing/candidate-decision.ts";
import {
  PatchReadinessSchema,
  readPatchReadiness,
  readPatchReadinessBatch,
} from "../../self-healing/candidate-readiness.ts";
import { previewPatchCandidate } from "../../self-healing/candidate-review.ts";
import { readOpenPatchDecisions } from "../../self-healing/open-decisions.ts";
import { preparePatchCandidate } from "../../self-healing/prepare-candidate.ts";
import { ReportDeliveryBoundarySchema } from "../../workflows/report-delivery-boundary.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

const PatchStatusSchema = z.enum(["proposed", "applied", "rejected", "superseded", "inapplicable"]);

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
    ...PatchReadinessSchema.shape,
  })
  .openapi("PatchCandidatePreview");

const PrepareBody = z.object({ expected_review_digest: z.string().regex(/^[a-f0-9]{64}$/) });

type ListInput = z.infer<typeof ListQuery>;
type Readiness = Awaited<ReturnType<typeof readPatchReadiness>>;
type Preview = NonNullable<Awaited<ReturnType<typeof previewPatchCandidate>>>;
type Prepared = Awaited<ReturnType<typeof preparePatchCandidate>>;

interface IdInput {
  readonly id: string;
}

interface PrepareInput extends IdInput {
  readonly expected_review_digest: string;
}

interface ReviewedCandidate {
  readonly candidate: PatchCandidateRow;
  readonly workflow_name: string | null;
  readonly readiness: Readiness;
}

interface ListResult {
  readonly items: ReviewedCandidate[];
  readonly total: number;
  readonly reviewable_total: number;
}

function serialize({ candidate: row, workflow_name, readiness }: ReviewedCandidate) {
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
