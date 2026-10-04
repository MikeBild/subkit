import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { getConversation } from "../../../conversations/index.ts";
import { logger } from "../../../logging/index.ts";
import { recordSuggestNextOutcome } from "../../../observability/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { SuggestNextFeedbackBody } from "./schemas.ts";

const FeedbackResponse = z.object({ ok: z.literal(true) }).openapi("SuggestNextFeedbackResponse");

const feedbackRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{id}/suggest-next/feedback",
  tags: ["conversations"],
  summary: "Record an accept / dismiss / typed-over outcome for a suggestion",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: SuggestNextFeedbackBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: FeedbackResponse } } },
    401: {
      description: "Unauthenticated",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Missing conversation:read permission",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    400: {
      description: "Body failed Zod validation",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerSuggestNextFeedbackRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(feedbackRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const conv = await getConversation(principal.tenant_id, id, db);
    if (!conv) {
      return c.json({ code: "conversation_not_found", message: "conversation not found" }, 404);
    }

    const outcome =
      body.source === "dismissed"
        ? "dismissed"
        : body.source === "typed-over"
          ? "typed_over"
          : body.accepted
            ? "accepted"
            : "dismissed";

    recordSuggestNextOutcome({
      tenant_id: principal.tenant_id,
      outcome,
    });

    logger.info({
      module: "conversations",
      action: "suggest_next.feedback",
      msg: "next-message suggestion feedback recorded",
      tenant_id: principal.tenant_id,
      conversation_id: id,
      source: body.source,
      accepted: body.accepted,
    });

    return c.json({ ok: true as const }, 200);
  });
}
