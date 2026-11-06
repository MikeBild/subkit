import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import { requireSignedInPerson } from "../../http/middleware/auth.ts";
import {
  approvalFailureOf,
  approveSkillCandidate,
  countSkillCandidates,
  getSkillCandidate,
  getSkillCandidateEvidence,
  listSkillCandidates,
  rejectSkillCandidate,
} from "../../skill-candidates/service.ts";
import {
  type ApproveSkillCandidateParams,
  SkillCandidateEvidenceSchema,
  SkillCandidatePatternSchema,
  SkillCandidateSchema,
  SkillCandidateStatusSchema,
} from "../../skill-candidates/types.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

const SkillCandidateListResponse = z
  .object({
    items: z.array(SkillCandidateSchema),
    reviewable_total: z.number().int().min(0),
    total: z.number().int().min(0),
  })
  .openapi("SkillCandidateListResponse");

const ListSkillCandidatesQuery = z
  .object({
    status: SkillCandidateStatusSchema.optional(),
    scope: z.enum(["global", "connector", "workflow"]).optional(),
    connector_id: z.string().uuid().optional(),
    workflow_id: z.string().uuid().optional(),
    pattern_kind: SkillCandidatePatternSchema.optional(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .openapi("ListSkillCandidatesQuery");

const RejectSkillCandidateBody = z
  .object({ reason: z.string().optional() })
  .openapi("RejectSkillCandidateBody");

const ApproveSkillCandidateBody = z
  .object({
    title: z.string().optional(),
    body: z.string().optional(),
    status: z.enum(["draft", "active"]).optional(),
    expected_review_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .openapi("ApproveSkillCandidateBody");

const ApproveSkillCandidateResponse = z
  .object({
    candidate: SkillCandidateSchema,
    skill_id: z.string().describe("The skill the detected pattern became."),
  })
  .openapi("ApproveSkillCandidateResponse");

const MAX_APPROVE_BATCH = 100;

const ApproveSkillCandidatesBody = z
  .object({
    candidates: z
      .array(
        z.object({
          id: z.string().uuid(),
          expected_review_digest: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .min(1)
      .max(MAX_APPROVE_BATCH)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
        message: "each candidate may appear once",
      }),
  })
  .openapi("ApproveSkillCandidatesBody");

const SkillCandidateApprovalResult = z
  .object({
    id: z.string().uuid(),
    outcome: z.enum(["approved", "changed_since_review", "not_found", "already_decided"]),
    skill_id: z.string().nullable().describe("The active skill the candidate became, if approved."),
  })
  .openapi("SkillCandidateApprovalResult");

const ApproveSkillCandidatesResponse = z
  .object({
    results: z.array(SkillCandidateApprovalResult),
    approved: z.number().int().min(0),
  })
  .openapi("ApproveSkillCandidatesResponse");

type ListQuery = z.infer<typeof ListSkillCandidatesQuery>;
type Candidate = NonNullable<Awaited<ReturnType<typeof getSkillCandidate>>>;
type Evidence = Awaited<ReturnType<typeof getSkillCandidateEvidence>>;
type Approved = NonNullable<Awaited<ReturnType<typeof approveSkillCandidate>>>;
type ApproveFields = z.infer<typeof ApproveSkillCandidateBody>;
type BatchInput = z.infer<typeof ApproveSkillCandidatesBody>;
type ApprovalResult = z.infer<typeof SkillCandidateApprovalResult>;

interface IdInput {
  readonly id: string;
}

interface RejectInput extends IdInput {
  readonly reason?: string | undefined;
}

interface ApproveInput extends IdInput {
  readonly body: ApproveFields;
}

interface ListResult {
  readonly items: Candidate[];
  readonly total: number;
  readonly reviewable_total: number;
}

function idFrom(param: unknown): IdInput {
  return { id: (param as IdInput).id };
}

export const listSkillCandidatesOperation = defineOperation<ListQuery, ListResult>({
  id: "skill_candidate.list",
  summary: "List skill candidates",
  permission: "skill:read",
  effect: "read",
  async handler(scope, q) {
    const params = {
      tenant_id: scope.tenant_id,
      ...(q.status ? { status: q.status } : {}),
      ...(q.scope ? { scope: q.scope } : {}),
      ...(q.connector_id ? { connector_id: q.connector_id } : {}),
      ...(q.workflow_id ? { workflow_id: q.workflow_id } : {}),
      ...(q.pattern_kind ? { pattern_kind: q.pattern_kind } : {}),
      ...(q.confidence ? { confidence: q.confidence } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.offset !== undefined ? { offset: q.offset } : {}),
    };
    const [items, total, reviewable_total] = await Promise.all([
      listSkillCandidates(params, scope.db),
      countSkillCandidates(params, scope.db),
      params.status === undefined || params.status === "proposed"
        ? countSkillCandidates({ ...params, status: "proposed" }, scope.db)
        : 0,
    ]);
    return { items, total, reviewable_total };
  },
  http: {
    method: "get",
    path: "/v1/skill-candidates",
    tags: ["skill-candidates"],
    query: ListSkillCandidatesQuery,
    response: SkillCandidateListResponse,
    errors: { 403: "Forbidden" },
    toInput: ({ query }) => query as ListQuery,
    toBody: ({ items, total, reviewable_total }) => ({ items, total, reviewable_total }),
  },
});

export const getSkillCandidateOperation = defineOperation<IdInput, Candidate>({
  id: "skill_candidate.get",
  summary: "Get a skill candidate",
  permission: "skill:read",
  effect: "read",
  async handler(scope, { id }) {
    return (
      (await getSkillCandidate(scope.tenant_id, id, scope.db)) ?? reject.notFound("skill_candidate")
    );
  },
  http: {
    method: "get",
    path: "/v1/skill-candidates/{id}",
    tags: ["skill-candidates"],
    params: IdParam,
    response: SkillCandidateSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: (candidate) => candidate,
  },
});

export const listSkillCandidateEvidenceOperation = defineOperation<IdInput, Evidence>({
  id: "skill_candidate.evidence",
  summary: "List the observed cases a skill candidate was distilled from",
  permission: "skill:read",
  effect: "read",
  async handler(scope, { id }) {
    const candidate = await getSkillCandidate(scope.tenant_id, id, scope.db);
    if (!candidate) return reject.notFound("skill_candidate");
    return await getSkillCandidateEvidence(scope.tenant_id, id, scope.db);
  },
  http: {
    method: "get",
    path: "/v1/skill-candidates/{id}/evidence",
    tags: ["skill-candidates"],
    description:
      "Approving a candidate adds operating knowledge the agent will act on, so a reviewer " +
      "needs to see what it rests on. The rows were always recorded and indexed; until now " +
      "only their COUNT reached any client, which asks a person to trust a number.",
    params: IdParam,
    response: z.object({ items: z.array(SkillCandidateEvidenceSchema) }),
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: (items) => ({ items }),
  },
});

function overridesOf(body: ApproveFields): ApproveSkillCandidateParams["overrides"] {
  const overrides = {
    ...(body.title ? { title: body.title } : {}),
    ...(body.body ? { body: body.body } : {}),
    ...(body.status ? { status: body.status } : {}),
  };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export const approveSkillCandidateOperation = defineOperation<ApproveInput, Approved>({
  id: "skill_candidate.approve",
  summary: "Approve a detected skill candidate and promote it to a skill",
  permission: "skill:write",
  effect: "write",
  audit: AuditAction.SKILL_CANDIDATE_APPROVED,
  async handler(scope, { id, body }) {
    const ensurePermission = scope.ensurePermission;
    if (!scope.principal || !ensurePermission) return reject.unauthorized();
    if (body.status === "active") await ensurePermission("skill:activate");
    const overrides = overridesOf(body);
    const result = await approveSkillCandidate(
      {
        tenant_id: scope.tenant_id,
        candidate_id: id,
        actor: actorOf(scope.principal),
        ...(body.expected_review_digest
          ? { expected_review_digest: body.expected_review_digest }
          : {}),
        ...(overrides ? { overrides } : {}),
      },
      scope.db,
    );
    if (result) return result;
    const candidate = await getSkillCandidate(scope.tenant_id, id, scope.db);
    if (approvalFailureOf(candidate) === "not_found") return reject.notFound("skill_candidate");
    return reject.conflict(
      "The skill candidate changed or was already decided",
      undefined,
      "review_changed",
    );
  },
  http: {
    method: "post",
    path: "/v1/skill-candidates/{id}/approve",
    tags: ["skill-candidates"],
    description:
      "Applies to patterns the engine detected. Learnings collected from sessions and conversations are intake items; they are reviewed and admitted through intake proposals, never here.",
    params: IdParam,
    body: ApproveSkillCandidateBody,
    response: ApproveSkillCandidateResponse,
    errors: { 404: "Not found", 409: "The skill candidate changed or was already decided" },
    toInput: ({ param, json }) => ({ ...idFrom(param), body: json as ApproveFields }),
    toBody: (result) => result,
  },
});

export const approveSkillCandidatesOperation = defineOperation<BatchInput, ApprovalResult[]>({
  id: "skill_candidate.approve_batch",
  summary: "Approve several detected skill candidates as active skills",
  permission: "skill:write",
  requiredPermissions: [{ permission: "skill:activate" }],
  effect: "write",
  audit: AuditAction.SKILL_CANDIDATE_APPROVED,
  async handler(scope, { candidates }) {
    const ensurePermission = scope.ensurePermission;
    if (!scope.principal || !ensurePermission) return reject.unauthorized();
    requireSignedInPerson(scope.principal, "a signed-in person must approve skill candidates");
    for (const candidate of candidates)
      await ensurePermission("skill:write", { type: "skill_candidate", id: candidate.id });
    const results: ApprovalResult[] = [];
    for (const candidate of candidates) {
      const approved = await approveSkillCandidate(
        {
          tenant_id: scope.tenant_id,
          candidate_id: candidate.id,
          actor: actorOf(scope.principal),
          expected_review_digest: candidate.expected_review_digest,
          overrides: { status: "active" },
        },
        scope.db,
      );
      results.push(
        approved
          ? { id: candidate.id, outcome: "approved", skill_id: approved.skill_id }
          : {
              id: candidate.id,
              outcome: approvalFailureOf(
                await getSkillCandidate(scope.tenant_id, candidate.id, scope.db),
              ),
              skill_id: null,
            },
      );
    }
    return results;
  },
  http: {
    method: "post",
    path: "/v1/skill-candidates/approve",
    tags: ["skill-candidates"],
    description:
      "Only a signed-in person may approve in a batch. Each candidate is bound to the review digest the person saw, checked, approved and audited on its own; the result lists an outcome per candidate.",
    body: ApproveSkillCandidatesBody,
    response: ApproveSkillCandidatesResponse,
    errors: { 403: "Not a signed-in person, or missing permission" },
    toInput: ({ json }) => json as BatchInput,
    toBody: (results) => ({
      results,
      approved: results.filter((result) => result.outcome === "approved").length,
    }),
  },
});

export const rejectSkillCandidateOperation = defineOperation<RejectInput, { rejected: true }>({
  id: "skill_candidate.reject",
  summary: "Reject a detected skill candidate",
  permission: "skill:write",
  effect: "write",
  audit: AuditAction.SKILL_CANDIDATE_REJECTED,
  async handler(scope, { id, reason }) {
    if (!scope.principal) return reject.unauthorized();
    const outcome = await rejectSkillCandidate(
      {
        tenant_id: scope.tenant_id,
        candidate_id: id,
        actor_id: scope.principal.id,
        actor_type: scope.principal.kind,
        ...(reason ? { reason } : {}),
      },
      scope.db,
    );
    if (outcome.kind === "not_found") return reject.notFound("skill_candidate");
    if (outcome.kind === "already_decided")
      return reject.conflict(
        "The skill candidate was already decided",
        { status: outcome.status },
        "already_decided",
      );
    return { rejected: true };
  },
  http: {
    method: "post",
    path: "/v1/skill-candidates/{id}/reject",
    tags: ["skill-candidates"],
    description:
      "Applies to patterns the engine detected. Collected learnings are intake items and are discarded in intake.",
    params: IdParam,
    body: RejectSkillCandidateBody,
    response: z.object({ rejected: z.boolean() }),
    errors: { 404: "Not found", 409: "The skill candidate was already decided" },
    toInput: ({ param, json }) => ({
      ...idFrom(param),
      reason: (json as z.infer<typeof RejectSkillCandidateBody>).reason,
    }),
    toBody: (result) => result,
  },
});
