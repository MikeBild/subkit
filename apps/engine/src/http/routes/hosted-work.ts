import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import {
  HostedWorkReviewError,
  HostedWorkStopReviewSchema,
  listHostedWorkForReview,
  reconcileHostedWorkAfterReviewedOwnerStop,
} from "../../queue/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const TenantParam = z.object({ tenant_id: z.uuid() });
const ReviewItem = z.object({
  admission_id: z.uuid(),
  tenant_id: z.uuid(),
  kind: z.enum(["execution", "chat"]),
  state: z.enum(["pending", "active", "reconciliation_required", "released"]),
  owner_boot_id: z.uuid(),
  started_at: z.string().datetime(),
  current_process: z.boolean(),
});
const errorResponse = {
  description: "Review refused",
  content: { "application/json": { schema: ErrorSchema } },
};
const path = "/v1/settings/hosted-work/{tenant_id}";
const listRoute = createRoute({
  method: "get",
  path,
  tags: ["settings"],
  summary: "List unresolved work for an operator browser review",
  security: [{ browserSession: [] }],
  request: { params: TenantParam },
  responses: {
    200: {
      description: "At most 100 unresolved admissions, oldest first",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(ReviewItem), has_more: z.boolean() }),
        },
      },
    },
    403: errorResponse,
  },
});
const releaseRoute = createRoute({
  method: "post",
  path,
  tags: ["settings"],
  summary: "Release one admission after a human reviews proof that its former owner stopped",
  security: [{ browserSession: [] }],
  request: {
    params: TenantParam,
    body: { content: { "application/json": { schema: HostedWorkStopReviewSchema } } },
  },
  responses: {
    200: {
      description: "Released after operator review; evidence text is not retained",
      content: {
        "application/json": {
          schema: z.object({
            admission_id: z.uuid(),
            state: z.literal("released"),
            evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        },
      },
    },
    403: errorResponse,
    409: errorResponse,
  },
});

export function registerHostedWorkRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/settings/hosted-work/*", requirePermission("settings:write:global"));
  app.openapi(listRoute, async (c) => {
    try {
      return c.json(
        await listHostedWorkForReview(c.get("db"), c.req.valid("param").tenant_id, requireAuth(c)),
        200,
      );
    } catch (error) {
      if (error instanceof HostedWorkReviewError)
        return c.json({ code: error.code, message: error.message }, 403);
      throw error;
    }
  });
  app.openapi(releaseRoute, async (c) => {
    try {
      return c.json(
        await reconcileHostedWorkAfterReviewedOwnerStop(
          c.get("db"),
          c.req.valid("param").tenant_id,
          requireAuth(c),
          c.req.valid("json"),
        ),
        200,
      );
    } catch (error) {
      if (error instanceof HostedWorkReviewError)
        return c.json(
          { code: error.code, message: error.message },
          error.code === "operator_browser_required" ? 403 : 409,
        );
      throw error;
    }
  });
}
