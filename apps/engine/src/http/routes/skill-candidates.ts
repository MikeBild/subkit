import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  getSkillCandidateOperation,
  listSkillCandidateEvidenceOperation,
  listSkillCandidatesOperation,
  rejectSkillCandidateOperation,
} from "../../api/operations/skill-candidates.ts";
import { actorOf } from "../../audit/index.ts";
import * as svc from "../../skill-candidates/index.ts";
import {
  type ApproveSkillCandidateParams,
  SkillCandidateSchema,
} from "../../skill-candidates/index.ts";
import { HttpError, NotFoundError } from "../errors.ts";
import { requireAuth, requireSignedInPerson } from "../middleware/auth.ts";
import { ensurePermission, requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const approveRoute = createRoute({
  method: "post",
  path: "/v1/skill-candidates/{id}/approve",
  tags: ["skill-candidates"],
  summary: "Approve a detected skill candidate and promote it to a skill",
  description:
    "Applies to patterns the engine detected. Learnings collected from sessions and conversations are intake items; they are reviewed and admitted through intake proposals, never here.",
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
              skill_id: z.string().describe("The skill the detected pattern became."),
            })
            .openapi("ApproveSkillCandidateResponse"),
        },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "The skill candidate changed or was already decided",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

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

const approveBatchRoute = createRoute({
  method: "post",
  path: "/v1/skill-candidates/approve",
  tags: ["skill-candidates"],
  summary: "Approve several detected skill candidates as active skills",
  description:
    "Only a signed-in person may approve in a batch. Each candidate is bound to the review digest the person saw, checked, approved and audited on its own; the result lists an outcome per candidate.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ApproveSkillCandidatesBody } },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z
            .object({
              results: z.array(SkillCandidateApprovalResult),
              approved: z.number().int().min(0),
            })
            .openapi("ApproveSkillCandidatesResponse"),
        },
      },
    },
    403: {
      description: "Not a signed-in person, or missing permission",
      content: { "application/json": { schema: ErrorSchema } },
    },
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

function isLearning(kind: string): boolean {
  return (svc.LEARNING_PATTERN_KINDS as readonly string[]).includes(kind);
}

function gateOtherMethods(
  methods: readonly string[],
  gate: MiddlewareHandler<AppEnv>,
): MiddlewareHandler<AppEnv> {
  return (c, next) => (methods.includes(c.req.method) ? next() : gate(c, next));
}

export function registerSkillCandidateRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use(
    "/v1/skill-candidates",
    gateOtherMethods(["GET", "HEAD"], requirePermission("skill:read")),
  );
  app.use("/v1/skill-candidates/approve", requirePermission("skill:write"));
  app.use("/v1/skill-candidates/approve", requirePermission("skill:activate"));
  app.use("/v1/skill-candidates/:id", gateOtherMethods(["GET"], requirePermission("skill:write")));
  app.use(
    "/v1/skill-candidates/:id/evidence",
    gateOtherMethods(["GET", "HEAD"], requirePermission("skill:read")),
  );
  app.use("/v1/skill-candidates/:id/approve", requirePermission("skill:write"));
  app.use(
    "/v1/skill-candidates/:id/reject",
    gateOtherMethods(["POST"], requirePermission("skill:write")),
  );
  app.use("/v1/skill-candidates/:id/approve", async (c, next) => {
    if (!(await approveBodyRequestsActivation(c))) return next();
    return requirePermission("skill:activate")(c, next);
  });

  toHonoRoute(app, listSkillCandidatesOperation);
  toHonoRoute(app, getSkillCandidateOperation);
  toHonoRoute(app, listSkillCandidateEvidenceOperation);

  app.openapi(approveRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const overrides: Record<string, unknown> = {};
    if (body.title) overrides.title = body.title;
    if (body.body) overrides.body = body.body;
    if (body.status) overrides.status = body.status;
    const result = await svc.approveSkillCandidate(
      {
        tenant_id: principal.tenant_id,
        candidate_id: id,
        actor: actorOf(principal),
        ...(body.expected_review_digest
          ? { expected_review_digest: body.expected_review_digest }
          : {}),
        ...(Object.keys(overrides).length > 0
          ? { overrides: overrides as ApproveSkillCandidateParams["overrides"] }
          : {}),
      },
      db,
    );
    if (!result) {
      const candidate = await svc.getSkillCandidate(principal.tenant_id, id, db);
      if (candidate && candidate.status !== "context" && !isLearning(candidate.pattern_kind))
        throw new HttpError(
          409,
          "review_changed",
          "The skill candidate changed or was already decided",
        );
      throw new NotFoundError("skill_candidate");
    }
    return c.json(result, 200);
  });

  app.openapi(approveBatchRoute, async (c) => {
    const principal = requireAuth(c);
    requireSignedInPerson(principal, "a signed-in person must approve skill candidates");
    const db = c.get("db");
    const { candidates } = c.req.valid("json");
    for (const candidate of candidates)
      await ensurePermission(c, "skill:write", { type: "skill_candidate", id: candidate.id });
    const results: z.infer<typeof SkillCandidateApprovalResult>[] = [];
    for (const candidate of candidates) {
      const approved = await svc.approveSkillCandidate(
        {
          tenant_id: principal.tenant_id,
          candidate_id: candidate.id,
          actor: actorOf(principal),
          expected_review_digest: candidate.expected_review_digest,
          overrides: { status: "active" },
        },
        db,
      );
      results.push(
        approved
          ? { id: candidate.id, outcome: "approved", skill_id: approved.skill_id }
          : {
              id: candidate.id,
              outcome: svc.approvalFailureOf(
                await svc.getSkillCandidate(principal.tenant_id, candidate.id, db),
              ),
              skill_id: null,
            },
      );
    }
    return c.json(
      { results, approved: results.filter((result) => result.outcome === "approved").length },
      200,
    );
  });

  toHonoRoute(app, rejectSkillCandidateOperation);
}
