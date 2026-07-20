import { z } from "@hono/zod-openapi";
import { ConnectorPromotionError } from "../../../../connectors/index.ts";
import type { ConversationTool } from "../../index.ts";

const PromoteConnectorInput = z
  .object({
    connector_id: z.string().uuid("connector id must be a UUID"),
    target_environment: z.literal("prod"),
    strategy: z.enum(["copy", "move"]),
  })
  .openapi("PromoteConnectorToolInput");

export const promoteConnectorTool: ConversationTool = {
  name: "promote_connector",
  description:
    "Promote a persisted connector and its encrypted credential binding from DEV to PROD. Copy keeps DEV; move preserves the same connector and credential ids.",
  use_case:
    "Use only after the operator explicitly asks to promote a DEV connector to PROD and specifies whether DEV should be retained.",
  important_notes: [
    "target_environment is always prod.",
    "copy creates new credential ciphertext without exposing or asking for the secret again.",
    "OAuth and end-user-bound connectors must use move so refresh and user bindings stay valid.",
    "The operation is idempotent and writes immutable connector and credential promotion audits.",
  ],
  inputSchema: PromoteConnectorInput,
  category: "tenant_write",
  permission: {
    action: "connector:promote",
    resourceType: "connector",
    resourceIdArg: "connector_id",
  },
  async execute(ctx, args: z.infer<typeof PromoteConnectorInput>) {
    const idempotencyKey = [
      "conversation",
      ctx.conversation_id,
      "connector",
      args.connector_id,
      "promote",
      args.strategy,
    ].join(":");
    try {
      const result = await ctx.engineClient.connectors.promote(
        args.connector_id,
        args.strategy,
        idempotencyKey,
      );
      return { ok: true, data: result };
    } catch (error) {
      if (error instanceof ConnectorPromotionError) {
        return {
          ok: false,
          error_code: error.code,
          message: error.message,
          details: { connector_id: args.connector_id, strategy: args.strategy },
          next_best_actions:
            error.code === "oauth_copy_unsupported" ||
            error.code === "end_user_credential_copy_unsupported"
              ? ["promote_connector"]
              : ["find_connector"],
        };
      }
      throw error;
    }
  },
};
