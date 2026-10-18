import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { AuditAction, auditAwait, readRequestSource } from "../../audit/index.ts";
import {
  approvePendingSecretVersion,
  listPendingSecretVersions,
  rejectPendingSecretVersion,
} from "../../runtime-config/pending-secrets.ts";
import { RuntimeConfigNotFoundError } from "../../runtime-config/service.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const PendingSecretSchema = z
  .object({
    name: z.string(),
    version: z.number().int().positive(),
    reference: z.string(),
    prepared_by: z.string(),
    pending_since: z.string(),
    bindings: z.array(z.string()),
  })
  .openapi("PendingSecretVersion");

const PendingSecretListResponse = z
  .object({ items: z.array(PendingSecretSchema) })
  .openapi("PendingSecretVersionListResponse");

const ApprovalResponse = z
  .object({
    name: z.string(),
    version: z.number().int().positive(),
    bindings: z.array(
      z.object({
        path: z.string(),
        outcome: z.enum(["rebound", "failed"]),
        detail: z.string().nullable(),
      }),
    ),
  })
  .openapi("SecretApprovalResponse");

const RejectionResponse = z
  .object({ name: z.string(), version: z.number().int().positive(), revoked_at: z.string() })
  .openapi("SecretRejectionResponse");

const Params = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/),
  version: z.coerce.number().int().positive(),
});

const listRoute = createRoute({
  method: "get",
  path: "/v1/secret-approvals",
  tags: ["secrets"],
  summary: "Prepared secret versions waiting for a person",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: PendingSecretListResponse } },
    },
  },
});

const approveRoute = createRoute({
  method: "post",
  path: "/v1/secret-approvals/{name}/{version}/approve",
  tags: ["secrets"],
  summary: "Approve a prepared version: it becomes current and its bindings are re-pinned",
  security: [{ bearerAuth: [] }],
  request: { params: Params },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ApprovalResponse } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const rejectRoute = createRoute({
  method: "post",
  path: "/v1/secret-approvals/{name}/{version}/reject",
  tags: ["secrets"],
  summary: "Reject a prepared version: it is revoked and never becomes current",
  security: [{ bearerAuth: [] }],
  request: { params: Params },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: RejectionResponse } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerSecretApprovalRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/secret-approvals", requirePermission("settings:read:global"));
  app.use("/v1/secret-approvals/*", requirePermission("settings:write:global"));

  app.openapi(listRoute, async (c) => {
    requireAuth(c);
    const items = await listPendingSecretVersions(c.get("db"));
    return c.json(
      {
        items: items.map((item) => ({
          ...item,
          pending_since: item.pending_since.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi(approveRoute, async (c) => {
    const principal = requireAuth(c);
    const { name, version } = c.req.valid("param");
    const db = c.get("db");
    let outcome: Awaited<ReturnType<typeof approvePendingSecretVersion>>;
    try {
      outcome = await approvePendingSecretVersion(db, { name, version, created_by: principal.id });
    } catch (error) {
      if (error instanceof RuntimeConfigNotFoundError) throw new NotFoundError("prepared version");
      throw error;
    }
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind === "system_account" ? "system_account" : "user",
        actor_id: principal.id,
        action: AuditAction.SECRET_VERSION_APPROVED,
        resource_type: "runtime_secret",
        resource_id: `secret://${name}/${version}`,
        result: outcome.bindings.some((b) => b.outcome === "failed") ? "error" : "success",
        metadata: {
          request_source: readRequestSource(c),
          name,
          version,
          bindings: outcome.bindings,
        },
      },
      db,
    );
    return c.json(outcome, 200);
  });

  app.openapi(rejectRoute, async (c) => {
    const principal = requireAuth(c);
    const { name, version } = c.req.valid("param");
    const db = c.get("db");
    let outcome: Awaited<ReturnType<typeof rejectPendingSecretVersion>>;
    try {
      outcome = await rejectPendingSecretVersion(db, { name, version });
    } catch (error) {
      if (error instanceof RuntimeConfigNotFoundError) throw new NotFoundError("prepared version");
      throw error;
    }
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind === "system_account" ? "system_account" : "user",
        actor_id: principal.id,
        action: AuditAction.SECRET_VERSION_REJECTED,
        resource_type: "runtime_secret",
        resource_id: `secret://${name}/${version}`,
        result: "success",
        metadata: { request_source: readRequestSource(c), name, version },
      },
      db,
    );
    return c.json({ ...outcome, revoked_at: outcome.revoked_at.toISOString() }, 200);
  });
}
