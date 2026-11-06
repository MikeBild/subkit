import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import {
  countSkillCandidates,
  getSkillCandidate,
  getSkillCandidateEvidence,
  listSkillCandidates,
  rejectSkillCandidate,
} from "../../skill-candidates/service.ts";
import {
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

type ListQuery = z.infer<typeof ListSkillCandidatesQuery>;
type Candidate = NonNullable<Awaited<ReturnType<typeof getSkillCandidate>>>;
type Evidence = Awaited<ReturnType<typeof getSkillCandidateEvidence>>;

interface IdInput {
  readonly id: string;
}

interface RejectInput extends IdInput {
  readonly reason?: string | undefined;
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

export const rejectSkillCandidateOperation = defineOperation<RejectInput, { outcome: "rejected" }>({
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
    return { outcome: "rejected" };
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
    toBody: () => ({ rejected: true }),
  },
});
