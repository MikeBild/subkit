// Patch Candidate HTTP surface.
//
// Routes:
//   GET    /v1/patch-candidates                — list (optional status + workflow filters)
//   GET    /v1/patch-candidates/:id            — fetch one
//   POST   /v1/patch-candidates/:id/approve    — manual apply (writes audit + workflow_version)
//   POST   /v1/patch-candidates/:id/reject     — reject with optional reason
//
// The list + get endpoints are intentionally read-only. Mutations go
// through the self-healing service so the audit trail + classifier
// context stays in one place.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { patchCandidates } from "../../db/schema/index.ts";
import { approvePatchCandidate, rejectPatchCandidate } from "../../self-healing/index.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const PatchCandidateSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    workflow_id: z.string(),
    classification: z.enum(["safe", "unsafe"]),
    status: z.enum(["proposed", "applied", "rejected", "superseded"]),
    fixture_id: z.string().nullable(),
    diff: z.unknown(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("PatchCandidate");

const ListResponse = z
  .object({ items: z.array(PatchCandidateSchema) })
  .openapi("PatchCandidateListResponse");

const ListQuery = z
  .object({
    status: z.enum(["proposed", "applied", "rejected", "superseded"]).optional(),
    workflow_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .openapi("ListPatchCandidatesQuery");

const RejectBody = z.object({ reason: z.string().optional() }).openapi("RejectPatchCandidateBody");

function serialize(row: typeof patchCandidates.$inferSelect) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
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

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const conds = [eq(patchCandidates.tenant_id, principal.tenant_id)];
    if (q.status) conds.push(eq(patchCandidates.status, q.status));
    if (q.workflow_id) conds.push(eq(patchCandidates.workflow_id, q.workflow_id));
    // tenant-filter:exempt — tenant-scoped via principal at the route boundary; child rows reached by parent FK
    const rows = await db
      .select()
      .from(patchCandidates)
      .where(and(...conds))
      .orderBy(desc(patchCandidates.created_at))
      .limit(q.limit ?? 50);
    return c.json({ items: rows.map(serialize) }, 200);
  });

  app.openapi(getRouteSpec, async (c) => {
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
    return c.json(serialize(row), 200);
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
      throw new ConflictError(
        `patch candidate is ${row.status}; only 'proposed' candidates can be approved`,
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
      throw new ConflictError(
        `patch candidate is ${row.status}; only 'proposed' candidates can be rejected`,
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
