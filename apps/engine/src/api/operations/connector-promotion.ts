import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { ConnectorPromotionError, promoteConnector } from "../../connectors/promotion.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, type Rejection, reject } from "./index.ts";

const PromotionStrategySchema = z.enum(["copy", "move"]);

const ConnectorPromotionBodySchema = z
  .object({
    target_environment: z.literal("prod"),
    strategy: PromotionStrategySchema,
  })
  .openapi("ConnectorPromotionBody");

const ConnectorPromotionHeaders = z.object({
  "idempotency-key": z.string().min(8).max(128),
});

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
          "signed_jwt",
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

interface ConnectorPromotionInput {
  readonly id: string;
  readonly strategy: z.infer<typeof PromotionStrategySchema>;
  readonly idempotency_key: string;
}

type ConnectorPromotionResult = Awaited<ReturnType<typeof promoteConnector>>;

function promotionRejection(error: ConnectorPromotionError): Rejection {
  if (error.code === "source_not_found") return reject.notFound("connector");
  if (
    error.code === "source_not_dev" ||
    error.code === "target_exists" ||
    error.code === "idempotency_conflict"
  ) {
    return reject.status(409, error.code, error.message);
  }
  return reject.status(422, error.code, error.message);
}

export const promoteConnectorOperation = defineOperation<
  ConnectorPromotionInput,
  ConnectorPromotionResult
>({
  id: "connector.promote",
  summary: "Promote a connector and its credentials from DEV to PROD",
  permission: "connector:promote",
  resource: { type: "connector", param: "id" },
  effect: "write",
  audit: AuditAction.CONNECTOR_ENVIRONMENT_PROMOTED,
  async handler(scope, input) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      return await promoteConnector(
        {
          tenant_id: scope.tenant_id,
          source_connector_id: input.id,
          strategy: input.strategy,
          idempotency_key: input.idempotency_key,
          actor_id: principal.id,
          actor_type: principal.kind,
          request_source: "http",
        },
        scope.db,
      );
    } catch (error) {
      if (error instanceof ConnectorPromotionError) return promotionRejection(error);
      throw error;
    }
  },
  http: {
    method: "post",
    path: "/v1/connectors/{id}/promote",
    tags: ["connectors"],
    params: IdParam,
    headers: ConnectorPromotionHeaders,
    body: ConnectorPromotionBodySchema,
    response: ConnectorPromotionResponseSchema,
    success: [
      { status: 200, description: "Moved or idempotently replayed" },
      { status: 201, description: "Copied" },
    ],
    statusFor: (result) => (result.idempotent_replay || result.strategy === "move" ? 200 : 201),
    errors: {
      404: "Not found",
      409: "Conflict",
      422: "Promotion is not safe for the connector state",
    },
    toInput: ({ param, json, header }) => ({
      id: (param as { id: string }).id,
      strategy: (json as z.infer<typeof ConnectorPromotionBodySchema>).strategy,
      idempotency_key: (header as z.infer<typeof ConnectorPromotionHeaders>)["idempotency-key"],
    }),
    toBody: (result) => result,
  },
});
