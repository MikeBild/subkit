// Skill Candidates HTTP surface (programmatic / SDK access).
//
// The primary UX is conversational (list_skill_suggestions tool +
// /approve slash command). These endpoints exist for SDK consumers
// and admin tooling.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import * as svc from "../../skill-candidates/index.ts";
import {
  type ApproveSkillCandidateParams,
  SkillCandidateEvidenceSchema,
  SkillCandidatePatternSchema,
  SkillCandidateSchema,
} from "../../skill-candidates/index.ts";
import { HttpError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const SkillCandidateListResponse = z
  .object({
    items: z.array(SkillCandidateSchema),
    // True matching-row count for the applied filters (ignores limit/offset)
    // — clients rendering counts must not derive them from a capped page.
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
        status: z.enum(["proposed", "approved", "rejected", "superseded"]).optional(),
        scope: z.enum(["global", "connector", "workflow"]).optional(),
        connector_id: z.string().uuid().optional(),
        workflow_id: z.string().uuid().optional(),
        // The canonical pattern enum — a hand-copied subset here silently
        // 400s filters for newer kinds (session_learning fell through).
        pattern_kind: SkillCandidatePatternSchema.optional(),
        reviewable: z.enum(["true", "false"]).optional(),
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
              skill_id: z.string(),
            })
            .openapi("ApproveSkillCandidateResponse"),
        },
      },
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

/**
 * True when the approve body asks for the promoted Skill to go live
 * immediately (`status: "active"`).
 *
 * Reads the parsed body from Hono's body cache, so the zod validator on the
 * route still sees it. A missing or unparseable body is not an activation
 * request — the validator rejects it on its own terms.
 */
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
  // Sub-paths need their own registration: a non-wildcard `app.use` matches
  // its exact path only, so the two lines above never covered `/approve` and
  // `/reject`. Without these, both ran on authentication alone — a read-only
  // credential could promote a candidate into a Skill. Mirrors the explicit
  // per-sub-path registration in `patch-candidates.ts` and `skills.ts`.
  app.use("/v1/skill-candidates/:id/evidence", requirePermission("skill:read"));
  app.use("/v1/skill-candidates/:id/approve", requirePermission("skill:write"));
  app.use("/v1/skill-candidates/:id/reject", requirePermission("skill:write"));
  // Approving with `status: "active"` both promotes AND activates. Activating
  // is a separate decision with its own permission (`POST /v1/skills/{id}/activate`
  // enforces it), so this route must demand it too — otherwise it is a way
  // around that gate. Registered after the `skill:write` check above, so the
  // caller needs both.
  app.use("/v1/skill-candidates/:id/approve", async (c, next) => {
    if (!(await approveBodyRequestsActivation(c))) return next();
    return requirePermission("skill:activate")(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const params = {
      tenant_id: principal.tenant_id,
      ...(q.reviewable !== undefined ? { reviewable: q.reviewable === "true" } : {}),
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
      svc.countSkillCandidates({ ...params, reviewable: true }, db),
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
    // The service returns an empty array for a candidate in another tenant,
    // which would read as "no evidence" rather than "not yours" — so the
    // existence check happens here and answers 404.
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
    let result: Awaited<ReturnType<typeof svc.approveSkillCandidate>>;
    try {
      result = await svc.approveSkillCandidate(
        {
          tenant_id: principal.tenant_id,
          candidate_id: id,
          actor_id: principal.id,
          ...(body.expected_review_digest
            ? { expected_review_digest: body.expected_review_digest }
            : {}),
          ...(Object.keys(overrides).length > 0
            ? { overrides: overrides as ApproveSkillCandidateParams["overrides"] }
            : {}),
        },
        db,
      );
    } catch (err) {
      if (err instanceof svc.AdvisoryCandidateError)
        throw new HttpError(
          409,
          "candidate_advisory",
          "This proposal is advisory context and cannot be adopted as a skill",
        );
      throw err;
    }
    if (!result) {
      const candidate = await svc.getSkillCandidate(principal.tenant_id, id, db);
      if (candidate)
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
        ...(body.reason ? { reason: body.reason } : {}),
      },
      db,
    );
    if (!rejected) throw new NotFoundError("skill_candidate");
    return c.json({ rejected: true }, 200);
  });
}
