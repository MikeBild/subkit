import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ErrorSchema } from "../../api/common-schemas.ts";
import {
  HostedObjectReviewError,
  HostedObjectStopReviewSchema,
  listHostedObjectsForReview,
  reconcileHostedObjectAfterReviewedRemoteStop,
} from "../../storage/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const TenantParam = z.object({ tenant_id: z.uuid() });
const errorResponse = {
  description: "Review refused",
  content: { "application/json": { schema: ErrorSchema } },
};
const path = "/v1/settings/hosted-storage/{tenant_id}";
const listRoute = createRoute({
  method: "get",
  path,
  tags: ["settings"],
  summary: "List unresolved uploads for an operator browser review",
  security: [{ browserSession: [] }],
  request: { params: TenantParam },
  responses: {
    200: {
      description: "At most 100 pending object reservations, oldest first",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(
              z.object({
                reservation_id: z.uuid(),
                tenant_id: z.uuid(),
                storage_key: z.string(),
                storage_namespace: z.string().regex(/^[0-9a-f]{64}$/),
                declared_bytes: z.string().regex(/^[1-9][0-9]*$/),
                created_at: z.iso.datetime(),
                updated_at: z.iso.datetime(),
              }),
            ),
            has_more: z.boolean(),
          }),
        },
      },
    },
    403: errorResponse,
    409: errorResponse,
    503: errorResponse,
  },
});
const reconcileRoute = createRoute({
  method: "post",
  path,
  tags: ["settings"],
  summary: "Remove one pending object after review of proof that every remote upload ended",
  security: [{ browserSession: [] }],
  request: {
    params: TenantParam,
    body: { content: { "application/json": { schema: HostedObjectStopReviewSchema } } },
  },
  responses: {
    200: {
      description:
        "Verified physical absence and exactly one quota release; evidence text is not retained",
      content: {
        "application/json": {
          schema: z.object({
            reservation_id: z.uuid(),
            state: z.literal("resolved_absent"),
            evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
          }),
        },
      },
    },
    403: errorResponse,
    409: errorResponse,
    503: errorResponse,
  },
});
function reviewFailure(c: Context<AppEnv>, error: HostedObjectReviewError) {
  const failure = { code: error.code, message: error.message };
  if (error.code === "operator_browser_required") return c.json(failure, 403);
  if (error.code === "storage_operation_failed") return c.json(failure, 503);
  return c.json(failure, 409);
}
export function registerHostedStorageRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/settings/hosted-storage/*", requirePermission("settings:write:global"));
  app.openapi(listRoute, async (c) => {
    try {
      return c.json(
        await listHostedObjectsForReview(
          c.get("db"),
          c.req.valid("param").tenant_id,
          requireAuth(c),
        ),
        200,
      );
    } catch (error) {
      if (error instanceof HostedObjectReviewError) return reviewFailure(c, error);
      throw error;
    }
  });
  app.openapi(reconcileRoute, async (c) => {
    try {
      return c.json(
        await reconcileHostedObjectAfterReviewedRemoteStop(
          c.get("db"),
          c.req.valid("param").tenant_id,
          requireAuth(c),
          c.req.valid("json"),
        ),
        200,
      );
    } catch (error) {
      if (error instanceof HostedObjectReviewError) return reviewFailure(c, error);
      throw error;
    }
  });
}
