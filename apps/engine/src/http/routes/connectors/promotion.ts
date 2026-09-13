import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { ConnectorPromotionError, promoteConnector } from "../../../connectors/index.ts";
import { HttpError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const PromotionStrategySchema = z.enum(["copy", "move"]);

const ConnectorPromotionBodySchema = z
  .object({
    target_environment: z.literal("prod"),
    strategy: PromotionStrategySchema,
  })
  .openapi("ConnectorPromotionBody");

const ConnectorPromotionResponseSchema = z
  .object({
    strategy: PromotionStrategySchema,
    source_connector_id: z.string().uuid(),
    target_connector_id: z.string().uuid(),
    source_environment: z.literal("dev"),
    target_environment: z.literal("prod"),
    source_retained: z.boolean(),
    credential_mappings: z.array(
      z.object({
        mode: z.enum([
          "none",
          "header",
          "query",
          "bearer",
          "basic",
          "oauth2",
          "aws_sigv4",
          "token_mint",
          "oauth2_client",
          "oauth2_private_key",
        ]),
        source_credential_id: z.string().uuid(),
        target_credential_id: z.string().uuid(),
      }),
    ),
    idempotent_replay: z.boolean(),
    audit_log_ids: z.array(z.string().uuid()),
  })
  .openapi("ConnectorPromotionResponse");

const promotionRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/promote",
  tags: ["connectors"],
  summary: "Promote a connector and its credentials from DEV to PROD",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    headers: z.object({
      "idempotency-key": z.string().min(8).max(128),
    }),
    body: { content: { "application/json": { schema: ConnectorPromotionBodySchema } } },
  },
  responses: {
    200: {
      description: "Moved or idempotently replayed",
      content: { "application/json": { schema: ConnectorPromotionResponseSchema } },
    },
    201: {
      description: "Copied",
      content: { "application/json": { schema: ConnectorPromotionResponseSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
    422: {
      description: "Promotion is not safe for the connector state",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

function mapPromotionError(error: ConnectorPromotionError): never {
  if (error.code === "source_not_found") throw new NotFoundError("connector");
  if (error.code === "source_not_dev" || error.code === "target_exists") {
    throw new HttpError(409, error.code, error.message);
  }
  if (error.code === "idempotency_conflict") {
    throw new HttpError(409, error.code, error.message);
  }
  throw new HttpError(422, error.code, error.message);
}

export function registerPromotionRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(promotionRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const headers = c.req.valid("header");
    try {
      const result = await promoteConnector(
        {
          tenant_id: principal.tenant_id,
          source_connector_id: id,
          strategy: body.strategy,
          idempotency_key: headers["idempotency-key"],
          actor_id: principal.id,
          actor_type: principal.kind,
          request_source: "http",
        },
        c.get("db"),
      );
      if (result.idempotent_replay || result.strategy === "move") {
        return c.json(result, 200);
      }
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof ConnectorPromotionError) mapPromotionError(error);
      throw error;
    }
  });
}
