import { z } from "@hono/zod-openapi";
import { withConnectorDraft } from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import type { ConnectorDraftDocument } from "../types.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    driver: z.enum(["http", "postgres", "s3", "graphql"]).optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
    base_url: z.string().optional(),
    dsn: z.string().optional(),
    auth_type: z.enum(["none", "header", "query", "bearer", "basic", "oauth2"]).optional(),
  })
  .openapi("StartConnectorFromDescriptionToolInput");

export const startConnectorFromDescriptionTool: ConversationTool = {
  name: "start_connector_from_description",
  description:
    "Start a connector draft directly from the user's description. Use this as the default path when the user did not explicitly choose a template.",
  inputSchema,
  category: "draft_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const inferredDriver =
      args.driver ??
      (args.dsn
        ? "postgres"
        : args.base_url?.includes("/graphql") || /graphql/i.test(args.description ?? "")
          ? "graphql"
          : "http");
    const connector: ConnectorDraftDocument = {
      name: args.name,
      slug: args.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64),
      driver: inferredDriver,
      environment: args.environment,
      ...(args.description ? { description: args.description } : {}),
      ...(args.base_url ? { base_url: args.base_url } : {}),
      ...(args.dsn ? { dsn: args.dsn } : {}),
      auth_type: args.auth_type ?? "none",
      config: {},
      docs: [],
      latest_probe: null,
      saved_connector_id: null,
    };
    const validation = validateConnectorDraft(connector);
    await ctx.setDraft(
      withConnectorDraft(
        ctx.getDraft(),
        { ...connector, validation, template_id: null, template_name: null },
        "connector_started_from_description",
      ),
    );
    return {
      ok: true,
      data: {
        connector: {
          name: connector.name,
          slug: connector.slug,
          driver: connector.driver,
          environment: connector.environment,
          auth_type: connector.auth_type,
        },
        validation,
      },
    };
  },
};
