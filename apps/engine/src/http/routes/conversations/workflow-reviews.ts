import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { browserSessionForPrincipal, verifyBrowserCsrf } from "../../../auth/index.ts";
import {
  FinalizeWorkflowReviewSchema,
  finalizeWorkflowReview,
  getWorkflowReview,
  PrepareWorkflowReviewSchema,
  prepareWorkflowReview,
  WorkflowReviewError,
  WorkflowReviewReceiptSchema,
} from "../../../workflows/index.ts";
import { HttpError } from "../../errors.ts";
import { requireAuth, requireSignedInPerson } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const ConversationParam = z.object({ id: z.string().uuid() });
const ReviewParam = ConversationParam.extend({ receipt_id: z.string().uuid() });

const prepareRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/workflow-reviews",
  tags: ["conversations"],
  security: [{ bearerAuth: [] }],
  request: {
    params: ConversationParam,
    body: { content: { "application/json": { schema: PrepareWorkflowReviewSchema } } },
  },
  responses: {
    201: {
      description: "Prepared review",
      content: { "application/json": { schema: WorkflowReviewReceiptSchema } },
    },
    409: {
      description: "Stale or unavailable review",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Human session required",
      content: { "application/json": { schema: ErrorSchema } },
    },
    410: {
      description: "Review expired",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Review blocked",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/conversations/{id}/workflow-reviews/{receipt_id}",
  tags: ["conversations"],
  security: [{ bearerAuth: [] }],
  request: { params: ReviewParam },
  responses: {
    200: {
      description: "Workflow review",
      content: { "application/json": { schema: WorkflowReviewReceiptSchema } },
    },
    404: {
      description: "Review not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Human session required",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const finalizeRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/workflow-reviews/{receipt_id}/finalize",
  tags: ["conversations"],
  security: [{ bearerAuth: [] }],
  request: {
    params: ReviewParam,
    body: { content: { "application/json": { schema: FinalizeWorkflowReviewSchema } } },
  },
  responses: {
    200: {
      description: "Completed review",
      content: { "application/json": { schema: WorkflowReviewReceiptSchema } },
    },
    409: { description: "Stale review", content: { "application/json": { schema: ErrorSchema } } },
    403: {
      description: "Human session required",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Review not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    410: {
      description: "Review expired",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Review blocked",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

function reviewError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof WorkflowReviewError)
    throw new HttpError(error.status, error.code, error.message);
  throw error;
}

async function browserHuman(
  c: {
    req: { raw: Request; header: (name: string) => string | undefined };
    get: (key: "principal") => ReturnType<typeof requireAuth> | undefined;
  },
  write = false,
) {
  const principal = requireAuth(c);
  requireSignedInPerson(principal, "a signed-in browser session is required to review a workflow");
  const session = await browserSessionForPrincipal(c.req.raw, principal);
  if (!session) throw new HttpError(403, "human_session_required", "human session required");
  if (
    write &&
    (c.req.header("sec-fetch-site") === "cross-site" ||
      !(await verifyBrowserCsrf(c.req.header("x-subkit-csrf") ?? "", session)))
  )
    throw new HttpError(403, "csrf_rejected", "valid browser CSRF proof required");
  return { principal, session };
}

export function registerWorkflowReviewRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(prepareRoute, async (c) => {
    const { principal, session } = await browserHuman(c, true);
    try {
      const review = await prepareWorkflowReview(
        {
          tenant_id: principal.tenant_id,
          conversation_id: c.req.valid("param").id,
          principal,
          session_id: session.session_id,
          raw: c.req.valid("json"),
        },
        c.get("db"),
      );
      return c.json(review, 201);
    } catch (error) {
      return reviewError(error);
    }
  });

  app.openapi(getRoute, async (c) => {
    const { principal, session } = await browserHuman(c);
    const { id, receipt_id } = c.req.valid("param");
    try {
      return c.json(
        await getWorkflowReview(
          {
            tenant_id: principal.tenant_id,
            conversation_id: id,
            receipt_id,
            principal,
            session_id: session.session_id,
          },
          c.get("db"),
        ),
        200,
      );
    } catch (error) {
      return reviewError(error);
    }
  });

  app.openapi(finalizeRoute, async (c) => {
    const { principal } = await browserHuman(c, true);
    const { id, receipt_id } = c.req.valid("param");
    try {
      return c.json(
        await finalizeWorkflowReview(
          {
            tenant_id: principal.tenant_id,
            conversation_id: id,
            receipt_id,
            principal,
            request: c.req.raw,
            raw: c.req.valid("json"),
          },
          c.get("db"),
        ),
        200,
      );
    } catch (error) {
      return reviewError(error);
    }
  });
}
