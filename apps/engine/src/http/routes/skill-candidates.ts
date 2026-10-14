import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { actorOf } from "../../audit/index.ts";
import {
  KnowledgeSlugConflictError,
  KnowledgeVersionConflictError,
} from "../../knowledge/index.ts";
import { can } from "../../rbac/index.ts";
import * as svc from "../../skill-candidates/index.ts";
import {
  type ApproveSkillCandidateParams,
  SkillCandidateEvidenceSchema,
  SkillCandidatePatternSchema,
  SkillCandidateSchema,
  SkillCandidateStatusSchema,
} from "../../skill-candidates/index.ts";
import { HttpError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const SkillCandidateListResponse = z
  .object({
    items: z.array(SkillCandidateSchema),
    reviewable_total: z.number().int().min(0),
    total: z.number().int().min(0),
  })
  .openapi("SkillCandidateListResponse");

const listRoute = createRoute({
  method: "get",
  path: "/v1/skill-candidates",
  tags: ["skill-candidates"],
  summary: "List skill candidates",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        status: SkillCandidateStatusSchema.optional(),
        scope: z.enum(["global", "connector", "workflow"]).optional(),
        connector_id: z.string().uuid().optional(),
        workflow_id: z.string().uuid().optional(),
        knowledge_source_id: z.string().uuid().optional(),
        pattern_kind: SkillCandidatePatternSchema.optional(),
        confidence: z.enum(["low", "medium", "high"]).optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .openapi("ListSkillCandidatesQuery"),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: SkillCandidateListResponse } },
    },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: {
      description: "Knowledge source not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/skill-candidates/{id}",
  tags: ["skill-candidates"],
  summary: "Get a skill candidate",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: SkillCandidateSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const evidenceRoute = createRoute({
  method: "get",
  path: "/v1/skill-candidates/{id}/evidence",
  tags: ["skill-candidates"],
  summary: "List the observed cases a skill candidate was distilled from",
  description:
    "Approving a candidate adds operating knowledge the agent will act on, so a reviewer " +
    "needs to see what it rests on. The rows were always recorded and indexed; until now " +
    "only their COUNT reached any client, which asks a person to trust a number.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(SkillCandidateEvidenceSchema) }),
        },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const approveRoute = createRoute({
  method: "post",
  path: "/v1/skill-candidates/{id}/approve",
  tags: ["skill-candidates"],
  summary: "Approve a skill candidate and promote to a skill",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              title: z.string().optional(),
              body: z.string().optional(),
              status: z.enum(["draft", "active"]).optional(),
              expected_review_digest: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .optional(),
            })
            .openapi("ApproveSkillCandidateBody"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z
            .object({
              candidate: SkillCandidateSchema,
              skill_id: z
                .string()
                .nullable()
                .describe("The skill a practice or pattern became; null for a fact."),
              knowledge: z
                .object({
                  knowledge_source_id: z.string(),
                  slug: z.string(),
                  version: z.number().int().nullable(),
                })
                .nullable()
                .describe("The knowledge source and version a fact was appended to."),
            })
            .openapi("ApproveSkillCandidateResponse"),
        },
      },
    },
    403: {
      description: "A fact writes knowledge and needs knowledge:write as well",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const rejectRoute = createRoute({
  method: "post",
  path: "/v1/skill-candidates/{id}/reject",
  tags: ["skill-candidates"],
  summary: "Reject a skill candidate",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({ reason: z.string().optional() }).openapi("RejectSkillCandidateBody"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ rejected: z.boolean() }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

async function approveBodyRequestsActivation(c: {
  req: { json: () => Promise<unknown> };
}): Promise<boolean> {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object") return false;
    return (body as Record<string, unknown>).status === "active";
  } catch {
    return false;
  }
}

export function registerSkillCandidateRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/skill-candidates", requirePermission("skill:read"));
  app.use("/v1/skill-candidates/:id", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("skill:read")(c, next);
    return requirePermission("skill:write")(c, next);
  });
  app.use("/v1/skill-candidates/:id/evidence", requirePermission("skill:read"));
  app.use("/v1/skill-candidates/:id/approve", requirePermission("skill:write"));
  app.use("/v1/skill-candidates/:id/reject", requirePermission("skill:write"));
  app.use("/v1/skill-candidates/:id/approve", async (c, next) => {
    if (!(await approveBodyRequestsActivation(c))) return next();
    return requirePermission("skill:activate")(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    let candidateIds: string[] | undefined;
    if (q.knowledge_source_id) {
      const permission = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "knowledge:read",
      });
      if (!permission.allow)
        throw new HttpError(
          403,
          "forbidden",
          "Reading source-specific proposals needs knowledge:read",
        );
      const matching = await svc.knowledgeSourceCandidateIds(
        principal.tenant_id,
        q.knowledge_source_id,
        db,
      );
      if (matching === null) throw new NotFoundError("knowledge_source");
      candidateIds = matching;
    }
    const params = {
      ...(candidateIds ? { candidate_ids: candidateIds } : {}),
      tenant_id: principal.tenant_id,
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
      svc.listSkillCandidates(params, db),
      svc.countSkillCandidates(params, db),
      params.status === undefined || params.status === "proposed"
        ? svc.countSkillCandidates({ ...params, status: "proposed" }, db)
        : 0,
    ]);
    return c.json({ items, total, reviewable_total }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const candidate = await svc.getSkillCandidate(principal.tenant_id, id, db);
    if (!candidate) throw new NotFoundError("skill_candidate");
    return c.json(candidate, 200);
  });

  app.openapi(evidenceRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const candidate = await svc.getSkillCandidate(principal.tenant_id, id, db);
    if (!candidate) throw new NotFoundError("skill_candidate");
    const items = await svc.getSkillCandidateEvidence(principal.tenant_id, id, db);
    return c.json({ items }, 200);
  });

  app.openapi(approveRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const overrides: Record<string, unknown> = {};
    if (body.title) overrides.title = body.title;
    if (body.body) overrides.body = body.body;
    if (body.status) overrides.status = body.status;
    const pending = await svc.getSkillCandidate(principal.tenant_id, id, db);
    const fact = pending?.pattern_kind === "knowledge_learning";
    const mayWriteKnowledge = fact
      ? (
          await can(db, {
            tenant_id: principal.tenant_id,
            principal,
            permission: "knowledge:write",
          })
        ).allow
      : false;
    if (fact && !mayWriteKnowledge) {
      throw new HttpError(
        403,
        "forbidden",
        "Approving a fact writes knowledge and needs knowledge:write",
        {
          details: { permission: "knowledge:write" },
        },
      );
    }
    const result = await svc
      .approveSkillCandidate(
        {
          tenant_id: principal.tenant_id,
          candidate_id: id,
          actor: actorOf(principal),
          may_write_knowledge: mayWriteKnowledge,
          ...(body.expected_review_digest
            ? { expected_review_digest: body.expected_review_digest }
            : {}),
          ...(Object.keys(overrides).length > 0
            ? { overrides: overrides as ApproveSkillCandidateParams["overrides"] }
            : {}),
        },
        db,
      )
      .catch((error: unknown) => {
        if (error instanceof svc.KnowledgeWriteNotAllowedError) {
          throw new HttpError(403, "forbidden", error.message, {
            details: { permission: "knowledge:write" },
          });
        }
        if (
          error instanceof KnowledgeVersionConflictError ||
          error instanceof KnowledgeSlugConflictError
        ) {
          throw new HttpError(409, "knowledge_target_conflict", error.message, {
            hint: "The knowledge source this fact lands in changed or is not a text source; review again.",
          });
        }
        throw error;
      });
    if (!result) {
      const candidate = await svc.getSkillCandidate(principal.tenant_id, id, db);
      if (candidate && candidate.status !== "context")
        throw new HttpError(
          409,
          "review_changed",
          "The skill candidate changed or was already decided",
        );
      throw new NotFoundError("skill_candidate");
    }
    return c.json(result, 200);
  });

  app.openapi(rejectRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const rejected = await svc.rejectSkillCandidate(
      {
        tenant_id: principal.tenant_id,
        candidate_id: id,
        actor_id: principal.id,
        actor_type: principal.kind,
        ...(body.reason ? { reason: body.reason } : {}),
      },
      db,
    );
    if (!rejected) throw new NotFoundError("skill_candidate");
    return c.json({ rejected: true }, 200);
  });
}
