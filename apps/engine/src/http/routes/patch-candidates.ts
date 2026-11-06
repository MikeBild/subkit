import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  getPatchCandidateOperation,
  listPatchCandidatesOperation,
  preparePatchCandidateOperation,
  previewPatchCandidateOperation,
} from "../../api/operations/patch-candidates.ts";
import {
  approveReviewedPatchCandidate,
  dryRunPatchCandidate,
  findPatchCandidate,
  PatchDecisionError,
  rejectPatchCandidate,
} from "../../self-healing/index.ts";
import { GrantWorkflowAuthoritySchema } from "../../workflows/index.ts";
import { HttpError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const RejectBody = z.object({ reason: z.string().optional() }).openapi("RejectPatchCandidateBody");

const approveRoute = createRoute({
  method: "post",
  path: "/v1/patch-candidates/{id}/approve",
  tags: ["patch-candidates"],
  summary: "Approve and apply a patch candidate",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              expected_review_digest: z.string().regex(/^[a-f0-9]{64}$/),
              execution_authority: GrantWorkflowAuthoritySchema.optional(),
            })
            .openapi("ApprovePatchCandidateBody"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Applied",
      content: {
        "application/json": {
          schema: z.object({ applied: z.boolean(), workflow_version_id: z.string().nullable() }),
        },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const DryRunResponse = z
  .object({
    ok: z.boolean(),
    error: z.string().nullable(),
    value_preview: z.unknown(),
    fixture_source: z.enum(["recorded", "synthesized"]),
  })
  .openapi("PatchCandidateDryRunResponse");

const dryRunRoute = createRoute({
  method: "post",
  path: "/v1/patch-candidates/{id}/dry-run",
  tags: ["patch-candidates"],
  summary: "Replay a patch candidate against a recorded or synthesized fixture",
  description:
    "Never mutates the candidate's status — this is a pre-approval check. Uses the fixture recorded at proposal time, or synthesizes one from the failing step's persisted request/response material.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "Dry-run ran",
      content: { "application/json": { schema: DryRunResponse } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "No fixture / step material to replay against",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const rejectRoute = createRoute({
  method: "post",
  path: "/v1/patch-candidates/{id}/reject",
  tags: ["patch-candidates"],
  summary: "Reject a patch candidate",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: RejectBody } } },
  },
  responses: {
    200: {
      description: "Rejected",
      content: { "application/json": { schema: z.object({ rejected: z.boolean() }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function gateOtherMethods(
  methods: readonly string[],
  gate: MiddlewareHandler<AppEnv>,
): MiddlewareHandler<AppEnv> {
  return (c, next) => (methods.includes(c.req.method) ? next() : gate(c, next));
}

export function registerPatchCandidateRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/patch-candidates/:id/approve", requirePermission("workflow:write"));
  app.use("/v1/patch-candidates/:id/reject", requirePermission("workflow:write"));
  app.use(
    "/v1/patch-candidates/:id/prepare",
    gateOtherMethods(["POST"], requirePermission("workflow:write")),
  );
  toHonoRoute(app, preparePatchCandidateOperation);
  app.use(
    "/v1/patch-candidates/:id/preview",
    gateOtherMethods(["GET", "HEAD"], requirePermission("workflow:read")),
  );
  app.use("/v1/patch-candidates/:id/dry-run", requirePermission("workflow:read"));

  toHonoRoute(app, listPatchCandidatesOperation);
  toHonoRoute(app, getPatchCandidateOperation);
  toHonoRoute(app, previewPatchCandidateOperation);

  app.openapi(dryRunRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const outcome = await dryRunPatchCandidate(
      {
        tenant_id: principal.tenant_id,
        candidate_id: id,
        actor_id: principal.id,
        actor_type: principal.kind,
      },
      db,
    );
    if (outcome.status === "not_found") throw new NotFoundError("patch_candidate");
    if (outcome.status === "no_proposal" || outcome.status === "no_step") {
      throw new HttpError(409, "conflict", "patch candidate carries no replayable step material", {
        hint: "this candidate came from a proactive scan with no failing-step snapshot — run the workflow once so the engine captures one, then re-scan",
      });
    }
    if (outcome.status === "gate_fix") {
      throw new HttpError(409, "not_replayable", "a gate repair has no fixture replay", {
        hint: "prepare the candidate (POST /v1/patch-candidates/{id}/prepare) and let a held preparation run of the prepared version show the request the gate now sees",
      });
    }
    if (outcome.status === "no_fixture") {
      throw new HttpError(409, "conflict", "no execution fixture to replay against", {
        hint: "run the workflow once so the engine captures a fixture, then retry the dry-run",
      });
    }
    return c.json(
      {
        ok: outcome.ok,
        error: outcome.error,
        value_preview: outcome.value_preview,
        fixture_source: outcome.fixture_source,
      },
      200,
    );
  });

  app.openapi(approveRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await findPatchCandidate(db, principal.tenant_id, id);
    if (!row) throw new NotFoundError("patch_candidate");
    if (row.status !== "proposed") {
      throw new HttpError(
        409,
        "conflict",
        `patch candidate is ${row.status}; only 'proposed' candidates can be approved`,
        {
          hint: "the candidate already reached a terminal status — a fresh drift scan may have superseded it; sk patch-candidates list shows what is still open",
        },
      );
    }
    let versionId: string | null;
    try {
      const body = c.req.valid("json");
      versionId = await approveReviewedPatchCandidate(db, {
        principal,
        request: c.req.raw,
        candidate: row,
        expected_review_digest: body.expected_review_digest,
        execution_authority: body.execution_authority,
      });
    } catch (error) {
      if (error instanceof PatchDecisionError)
        throw new HttpError(409, error.code, "The reviewed repair cannot be applied", {
          hint: "Load the candidate preview to inspect its current state and reason.",
        });
      if (error instanceof HttpError) throw error;
      const code = (error as { code?: string }).code;
      if (code)
        throw new HttpError(
          [
            "human_session_required",
            "human_session_expired",
            "csrf_rejected",
            "authority_permission_denied",
          ].includes(code)
            ? 403
            : 409,
          code,
          "The reviewed execution boundary could not be granted",
        );
      throw error;
    }
    if (!versionId) throw new HttpError(409, "already_decided", "Candidate is no longer proposed");
    return c.json({ applied: true, workflow_version_id: versionId }, 200);
  });

  app.openapi(rejectRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await findPatchCandidate(db, principal.tenant_id, id);
    if (!row) throw new NotFoundError("patch_candidate");
    if (row.status !== "proposed") {
      throw new HttpError(
        409,
        "conflict",
        `patch candidate is ${row.status}; only 'proposed' candidates can be rejected`,
        {
          hint: "the candidate already reached a terminal status — nothing to do; sk patch-candidates list shows what is still open",
        },
      );
    }
    const ok = await rejectPatchCandidate(
      {
        tenant_id: principal.tenant_id,
        candidate_id: id,
        actor_id: principal.id,
        actor_type: principal.kind,
        ...(body.reason ? { reason: body.reason } : {}),
      },
      db,
    );
    return c.json({ rejected: ok }, 200);
  });
}
