import { z } from "@hono/zod-openapi";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import { withConnectorDraft } from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import type { ConnectorDraftDocument } from "../types.ts";
import { buildDraftMutationPayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    driver: z.enum(["http", "postgres", "s3", "graphql"]).optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    base_url: z.string().optional(),
    dsn: z.string().optional(),
    auth_type: z.enum(["none", "header", "query", "bearer", "basic", "oauth2"]).optional(),
    template_slug: z.string().min(1).nullable().optional(),
    template_name: z.string().min(1).nullable().optional(),
    template_source: z.enum(["builtin", "tenant"]).nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    docs: z.array(z.string()).optional(),
  })
  .openapi("UpdateConnectorDraftToolInput");

export const updateConnectorDraftTool: ConversationTool = {
  name: "update_connector_draft",
  description:
    "Update fields on the current connector draft. Use this after each user answer so the operator can inspect the evolving connector before probing or saving.",
  inputSchema,
  category: "draft_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const current = ctx.getDraft().connector ?? {};
    const patch = Object.fromEntries(
      Object.entries(args).filter(([, value]) => value !== undefined),
    ) as Partial<ConnectorDraftDocument>;
    const next: ConnectorDraftDocument = {
      ...current,
      ...patch,
      config: args.config ?? current.config ?? {},
      docs: args.docs ?? current.docs ?? [],
      latest_probe: current.latest_probe ?? null,
      saved_connector_id: current.saved_connector_id ?? null,
    };
    const templates = await listResolvedConnectorTemplates(ctx.db, ctx.tenant_id);
    const validation = validateConnectorDraft(
      next,
      templates.map((entry) => entry.template),
    );
    const nextDraft = withConnectorDraft(
      ctx.getDraft(),
      { ...next, validation },
      "connector_updated",
    );
    await ctx.setDraft(nextDraft);
    return {
      ok: true,
      data: buildDraftMutationPayload(nextDraft, {
        resource_kind: "connector",
        extra: {
          connector: { ...next, validation },
          validation,
        },
      }),
    };
  },
};
