import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam, PaginationQuery } from "../../api/common-schemas.ts";
import {
  listTransactionalMailReceipts,
  TransactionalMailReceiptSchema,
} from "../../execution/index.ts";
import { getWorkflow } from "../../workflows/index.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const receiptsRoute = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/transactional-mail-receipts",
  tags: ["workflows"],
  summary: "Inspect durable transactional email outcomes without applicant data",
  description:
    "One immutable dispatch reservation per workflow and signed request ID. sent requires a Gmail message ID; attempted and delivery_unknown require inspection and never authorize automatic resend. Receipts survive execution cleanup. This read cannot retry delivery.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam, query: PaginationQuery },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(TransactionalMailReceiptSchema) }),
        },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});
export function registerTransactionalMailRoutes(app: OpenAPIHono<AppEnv>) {
  app.use(
    "/v1/workflows/:id/transactional-mail-receipts",
    requirePermission("workflow:read", (c) => ({ type: "workflow", id: c.req.param("id") ?? "" })),
  );
  app.openapi(receiptsRoute, async (c) => {
    const tenant = requireAuth(c).tenant_id;
    const workflow = c.req.valid("param").id;
    const db = c.get("db");
    if (!(await getWorkflow(tenant, workflow, db))) throw new NotFoundError("workflow not found");
    const { limit, offset } = c.req.valid("query");
    return c.json(
      {
        items: await listTransactionalMailReceipts(db, tenant, workflow, limit ?? 20, offset ?? 0),
      },
      200,
    );
  });
}
