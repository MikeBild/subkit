import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { ErrorSchema } from "../../api/common-schemas.ts";
import type { Db } from "../../db/client.ts";
import { workflowExecutionAuthorities } from "../../db/schema/index.ts";
import {
  GrantWorkflowAuthoritySchema,
  grantWorkflowAuthority,
  previewWorkflowAuthority,
  revokeWorkflowAuthority,
  WorkflowEffectManifestSchema,
} from "../../workflows/index.ts";
import { HttpError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const workflowParam = z.object({ id: z.string().uuid() });
const authorityParam = workflowParam.extend({ authority_id: z.string().uuid() });
const authoritySchema = z
  .object({
    id: z.string().uuid(),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid(),
    effect_manifest_digest: z.string(),
    effect_manifest: WorkflowEffectManifestSchema,
    execution_environment: z.enum(["dev", "prod"]),
    target_constraints: z.object({ targets: z.array(z.string()) }),
    valid_from: z.string().datetime(),
    valid_until: z.string().datetime(),
    max_runs: z.number().int(),
    reserved_runs: z.number().int(),
    remaining_runs: z.number().int(),
    created_by: z.string().uuid(),
    created_at: z.string().datetime(),
    revoked_at: z.string().datetime().nullable(),
    revoked_by: z.string().uuid().nullable(),
    state: z.enum([
      "approved",
      "not_yet_valid",
      "expired",
      "revoked",
      "exhausted",
      "invalidated",
      "unavailable",
    ]),
  })
  .openapi("WorkflowExecutionAuthority");
const previewSchema = z
  .object({
    manifest: WorkflowEffectManifestSchema,
    digest: z.string(),
    eligible_for_repeated_runs: z.boolean(),
    unavailable_steps: z.array(z.string()),
    suggested_bounds: z.object({
      valid_from: z.string().datetime(),
      valid_until: z.string().datetime(),
      max_runs: z.number().int(),
    }),
  })
  .openapi("WorkflowAuthorityPreview");
const failures = Object.fromEntries(
  [400, 401, 403, 404, 409].map((status) => [
    status,
    {
      description: "Invalid, unavailable or unauthorized authority boundary",
      content: { "application/json": { schema: ErrorSchema } },
    },
  ]),
);
const response = {
  description: "Exact local authority; does not activate or enqueue a workflow",
  content: { "application/json": { schema: authoritySchema } },
};
const preview = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/versions/{version_id}/authority-preview",
  tags: ["workflows"],
  summary: "Review the exact locally resolved effect boundary without executing it",
  security: [{ bearerAuth: [] }],
  request: {
    params: workflowParam.extend({ version_id: z.string().uuid() }),
    query: z.object({ environment: z.enum(["dev", "prod"]).default("dev") }),
  },
  responses: {
    200: {
      description: "Read-only review with finite default bounds",
      content: { "application/json": { schema: previewSchema } },
    },
    ...failures,
  },
});
const grant = createRoute({
  method: "post",
  path: "/v1/workflows/{id}/execution-authorities",
  tags: ["workflows"],
  summary: "Grant a reviewed finite boundary from an authenticated human browser",
  security: [{ bearerAuth: [] }],
  request: {
    params: workflowParam,
    body: { content: { "application/json": { schema: GrantWorkflowAuthoritySchema } } },
  },
  responses: { 201: response, ...failures },
});
const get = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/execution-authorities/{authority_id}",
  tags: ["workflows"],
  summary: "Read remaining runs, expiry and current effect binding",
  security: [{ bearerAuth: [] }],
  request: { params: authorityParam },
  responses: { 200: response, ...failures },
});
const revoke = createRoute({
  method: "post",
  path: "/v1/workflows/{id}/execution-authorities/{authority_id}/revoke",
  tags: ["workflows"],
  summary: "Revoke the exact execution authority from an authenticated human browser",
  security: [{ bearerAuth: [] }],
  request: { params: authorityParam },
  responses: { 200: response, ...failures },
});

function translate(error: unknown): never {
  const code = (error as { code?: unknown })?.code;
  const statuses: Record<string, number> = {
    workflow_version_unavailable: 404,
    authority_not_found: 404,
    human_session_required: 403,
    human_session_expired: 403,
    csrf_rejected: 403,
    authority_permission_denied: 403,
    authority_window_invalid: 400,
    authority_manifest_changed: 409,
    authority_effect_unbound: 409,
    authority_revoked: 409,
  };
  if (typeof code === "string" && statuses[code])
    throw new HttpError(statuses[code], code, (error as Error).message);
  throw error;
}

async function readAuthority(db: Db, tenant_id: string, workflow_id: string, authority_id: string) {
  const [row] = await db
    .select()
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, workflow_id),
        eq(workflowExecutionAuthorities.id, authority_id),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("execution authority");
  const clock = await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
  const now = clock.rows[0]?.now;
  if (!now) throw new Error("database clock unavailable");
  let state: z.infer<typeof authoritySchema>["state"] = row.revoked_at
    ? "revoked"
    : row.valid_until <= new Date(now)
      ? "expired"
      : row.reserved_runs >= row.max_runs
        ? "exhausted"
        : row.valid_from > new Date(now)
          ? "not_yet_valid"
          : "approved";
  if (state === "approved" || state === "not_yet_valid") {
    try {
      const current = await previewWorkflowAuthority(
        {
          tenant_id,
          workflow_id,
          workflow_version_id: row.workflow_version_id,
          execution_environment: row.execution_environment,
        },
        db,
      );
      if (current.digest !== row.effect_manifest_digest) state = "invalidated";
      else if (!current.eligible_for_repeated_runs) state = "unavailable";
    } catch (error) {
      if ((error as { code?: string }).code !== "workflow_version_unavailable") throw error;
      state = "invalidated";
    }
  }
  return authoritySchema.parse({
    ...row,
    state,
    remaining_runs: Math.max(0, row.max_runs - row.reserved_runs),
    valid_from: row.valid_from.toISOString(),
    valid_until: row.valid_until.toISOString(),
    created_at: row.created_at.toISOString(),
    revoked_at: row.revoked_at?.toISOString() ?? null,
  });
}

export function registerWorkflowAuthorityRoutes(app: OpenAPIHono<AppEnv>): void {
  for (const path of [
    "/v1/workflows/:id/versions/:version_id/authority-preview",
    "/v1/workflows/:id/execution-authorities/:authority_id",
  ])
    app.use(
      path,
      requirePermission("workflow:read", (c) => ({
        type: "workflow",
        id: c.req.param("id") ?? "",
      })),
    );
  for (const path of [
    "/v1/workflows/:id/execution-authorities",
    "/v1/workflows/:id/execution-authorities/:authority_id/revoke",
  ])
    app.use(
      path,
      requirePermission("workflow:write", (c) => ({
        type: "workflow",
        id: c.req.param("id") ?? "",
      })),
    );
  app.openapi(preview, async (c) => {
    const principal = requireAuth(c);
    const { id, version_id } = c.req.valid("param");
    try {
      const result = await previewWorkflowAuthority(
        {
          tenant_id: principal.tenant_id,
          workflow_id: id,
          workflow_version_id: version_id,
          execution_environment: c.req.valid("query").environment,
        },
        c.get("db"),
      );
      const clock = await c.get("db").execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
      const now = clock.rows[0]?.now;
      if (!now) throw new Error("database clock unavailable");
      return c.json(
        {
          ...result,
          suggested_bounds: {
            valid_from: new Date(now).toISOString(),
            valid_until: new Date(new Date(now).getTime() + 24 * 60 * 60_000).toISOString(),
            max_runs: 1,
          },
        },
        200,
      );
    } catch (error) {
      return translate(error);
    }
  });
  app.openapi(grant, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    try {
      const row = await grantWorkflowAuthority(id, c.req.valid("json"), {
        principal,
        request: c.req.raw,
        db: c.get("db"),
      });
      return c.json(await readAuthority(c.get("db"), principal.tenant_id, id, row.id), 201);
    } catch (error) {
      return translate(error);
    }
  });
  app.openapi(get, async (c) => {
    const principal = requireAuth(c);
    const { id, authority_id } = c.req.valid("param");
    return c.json(await readAuthority(c.get("db"), principal.tenant_id, id, authority_id), 200);
  });
  app.openapi(revoke, async (c) => {
    const principal = requireAuth(c);
    const { id, authority_id } = c.req.valid("param");
    try {
      await revokeWorkflowAuthority(id, authority_id, {
        principal,
        request: c.req.raw,
        db: c.get("db"),
      });
      return c.json(await readAuthority(c.get("db"), principal.tenant_id, id, authority_id), 200);
    } catch (error) {
      return translate(error);
    }
  });
}
