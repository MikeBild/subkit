// Patch Candidate HTTP surface.
//
// Routes:
//   GET    /v1/patch-candidates                — list (status/workflow filters, order, exact total)
//   GET    /v1/patch-candidates/:id            — fetch one
//   GET    /v1/patch-candidates/:id/preview    — human-readable before/after preview
//   POST   /v1/patch-candidates/:id/dry-run    — replay against a recorded/synthesized fixture
//   POST   /v1/patch-candidates/:id/approve    — manual apply (writes audit + workflow_version)
//   POST   /v1/patch-candidates/:id/reject     — reject with optional reason
//
// The list + get endpoints are intentionally read-only. Mutations go
// through the self-healing service so the audit trail + classifier
// context stays in one place.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { patchCandidates, workflows } from "../../db/schema/index.ts";
import {
  approvePatchCandidate,
  dryRunPatchCandidate,
  PatchProposalSchema,
  previewPatchCandidate,
  rejectPatchCandidate,
} from "../../self-healing/index.ts";
import { HttpError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const PatchCandidateSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    workflow_id: z.string(),
    // Joined from workflows — null when the workflow row is gone.
    workflow_name: z.string().nullable(),
    // Which connection and which of its endpoints drifted. Both are on the row
    // and neither was ever serialized, so a reviewer could see that a workflow
    // needs repairing without being told WHERE. Null for a workflow-scoped
    // signal that names no endpoint at all.
    connector_id: z.string().nullable(),
    endpoint_key: z.string().nullable(),
    classification: z.enum(["safe", "unsafe"]),
    status: z.enum(["proposed", "applied", "rejected", "superseded"]),
    fixture_id: z.string().nullable(),
    diff: z.unknown(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("PatchCandidate");

const ListResponse = z
  .object({
    items: z.array(PatchCandidateSchema),
    // True matching-row count for the applied filters (ignores limit)
    // — clients rendering counts must not derive them from a capped page.
    total: z.number().int().min(0),
  })
  .openapi("PatchCandidateListResponse");

const ListQuery = z
  .object({
    status: z.enum(["proposed", "applied", "rejected", "superseded"]).optional(),
    workflow_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    // `asc` keeps the oldest candidate inside the page — the decisions
    // queue reviews stalest-first.
    order: z.enum(["asc", "desc"]).optional(),
  })
  .openapi("ListPatchCandidatesQuery");

const RejectBody = z.object({ reason: z.string().optional() }).openapi("RejectPatchCandidateBody");

function serialize(row: typeof patchCandidates.$inferSelect, workflowName: string | null) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    workflow_name: workflowName,
    connector_id: row.connector_id ?? null,
    endpoint_key: row.endpoint_key ?? null,
    classification: row.classification,
    status: row.status,
    fixture_id: row.fixture_id ?? null,
    diff: row.diff,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/v1/patch-candidates",
  tags: ["patch-candidates"],
  summary: "List patch candidates",
  security: [{ bearerAuth: [] }],
  request: { query: ListQuery },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListResponse } } },
  },
});

const getRouteSpec = createRoute({
  method: "get",
  path: "/v1/patch-candidates/{id}",
  tags: ["patch-candidates"],
  summary: "Fetch a patch candidate",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: PatchCandidateSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const approveRoute = createRoute({
  method: "post",
  path: "/v1/patch-candidates/{id}/approve",
  tags: ["patch-candidates"],
  summary: "Approve and apply a patch candidate",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
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

const StepShapeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["request", "transform"]),
    data_selector: z.string().optional(),
    expression: z.string().optional(),
  })
  .openapi("PatchCandidateStepShape");

const PreviewResponse = z
  .object({
    candidate_id: z.string(),
    workflow_id: z.string(),
    classification: z.enum(["safe", "unsafe"]),
    status: z.enum(["proposed", "applied", "rejected", "superseded"]),
    drift_summary: z.string().nullable(),
    proposal: PatchProposalSchema.nullable(),
    fixture_available: z.boolean(),
    proposal_dry_run: z.record(z.string(), z.unknown()).nullable(),
    before_step: StepShapeSchema.nullable(),
    after_step: StepShapeSchema.nullable(),
    changed_paths: z.array(z.string()),
  })
  .openapi("PatchCandidatePreview");

const previewRoute = createRoute({
  method: "get",
  path: "/v1/patch-candidates/{id}/preview",
  tags: ["patch-candidates"],
  summary: "Human-readable before/after preview of a patch candidate",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: PreviewResponse } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
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

export function registerPatchCandidateRoutes(app: OpenAPIHono<AppEnv>): void {
  // Patch candidates are workflow-scoped so we gate on workflow:read /
  // workflow:write — they modify a concrete workflow version.
  app.use("/v1/patch-candidates", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("workflow:read")(c, next);
    return next();
  });
  app.use("/v1/patch-candidates/:id", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("workflow:read")(c, next);
    return next();
  });
  app.use("/v1/patch-candidates/:id/approve", async (c, next) => {
    return requirePermission("workflow:write")(c, next);
  });
  app.use("/v1/patch-candidates/:id/reject", async (c, next) => {
    return requirePermission("workflow:write")(c, next);
  });
  // Preview + dry-run are read-side: neither mutates the candidate.
  app.use("/v1/patch-candidates/:id/preview", async (c, next) => {
    return requirePermission("workflow:read")(c, next);
  });
  app.use("/v1/patch-candidates/:id/dry-run", async (c, next) => {
    return requirePermission("workflow:read")(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const tenantConds = [eq(patchCandidates.tenant_id, principal.tenant_id)];
    if (q.status) tenantConds.push(eq(patchCandidates.status, q.status));
    if (q.workflow_id) tenantConds.push(eq(patchCandidates.workflow_id, q.workflow_id));
    const [rows, countRows] = await Promise.all([
      db
        .select({ candidate: patchCandidates, workflow_name: workflows.name })
        .from(patchCandidates)
        .leftJoin(workflows, eq(workflows.id, patchCandidates.workflow_id))
        .where(and(...tenantConds))
        .orderBy(
          q.order === "asc" ? asc(patchCandidates.created_at) : desc(patchCandidates.created_at),
        )
        .limit(q.limit ?? 50),
      db
        .select({ cnt: count() })
        .from(patchCandidates)
        .where(and(...tenantConds)),
    ]);
    return c.json(
      {
        items: rows.map((r) => serialize(r.candidate, r.workflow_name)),
        total: Number(countRows[0]?.cnt ?? 0),
      },
      200,
    );
  });

  app.openapi(getRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const rows = await db
      .select({ candidate: patchCandidates, workflow_name: workflows.name })
      .from(patchCandidates)
      .leftJoin(workflows, eq(workflows.id, patchCandidates.workflow_id))
      .where(and(eq(patchCandidates.tenant_id, principal.tenant_id), eq(patchCandidates.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError("patch_candidate");
    return c.json(serialize(row.candidate, row.workflow_name), 200);
  });

  app.openapi(previewRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const preview = await previewPatchCandidate(principal.tenant_id, id, db);
    if (!preview) throw new NotFoundError("patch_candidate");
    return c.json(preview, 200);
  });

  app.openapi(dryRunRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const outcome = await dryRunPatchCandidate(
      { tenant_id: principal.tenant_id, candidate_id: id, actor_id: principal.id },
      db,
    );
    if (outcome.status === "not_found") throw new NotFoundError("patch_candidate");
    if (outcome.status === "no_proposal" || outcome.status === "no_step") {
      throw HttpError.withEnvelope(
        409,
        "conflict",
        "patch candidate carries no replayable step material",
        {
          hint: "this candidate came from a proactive scan with no failing-step snapshot — run the workflow once so the engine captures one, then re-scan",
        },
      );
    }
    if (outcome.status === "no_fixture") {
      throw HttpError.withEnvelope(409, "conflict", "no execution fixture to replay against", {
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
    const rows = await db
      .select()
      .from(patchCandidates)
      .where(and(eq(patchCandidates.tenant_id, principal.tenant_id), eq(patchCandidates.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError("patch_candidate");
    if (row.status !== "proposed") {
      throw HttpError.withEnvelope(
        409,
        "conflict",
        `patch candidate is ${row.status}; only 'proposed' candidates can be approved`,
        {
          hint: "the candidate already reached a terminal status — a fresh drift scan may have superseded it; sk patch-candidates list shows what is still open",
        },
      );
    }
    const versionId = await approvePatchCandidate(
      { tenant_id: principal.tenant_id, candidate_id: id, actor_id: principal.id },
      db,
    );
    return c.json({ applied: !!versionId, workflow_version_id: versionId }, 200);
  });

  app.openapi(rejectRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const rows = await db
      .select()
      .from(patchCandidates)
      .where(and(eq(patchCandidates.tenant_id, principal.tenant_id), eq(patchCandidates.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError("patch_candidate");
    if (row.status !== "proposed") {
      throw HttpError.withEnvelope(
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
        ...(body.reason ? { reason: body.reason } : {}),
      },
      db,
    );
    return c.json({ rejected: ok }, 200);
  });
}
