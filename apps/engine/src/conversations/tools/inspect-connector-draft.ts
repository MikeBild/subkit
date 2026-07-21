import { z } from "@hono/zod-openapi";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import { withConnectorInspection } from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { buildLifecyclePayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("InspectConnectorDraftToolInput");

export const inspectConnectorDraftTool: ConversationTool = {
  name: "inspect_connector_draft",
  description:
    "Inspect the current connector draft, including missing fields, validation state, latest probe, and the recommended next action.",
  inputSchema,
  category: "draft_write",
  authoring_resource: "connector",
  requires_draft: true,
  async execute(ctx): Promise<ToolResult> {
    const nextDraft = withConnectorInspection(ctx.getDraft());
    await ctx.setDraft(nextDraft);
    const templates = await listResolvedConnectorTemplates(ctx.db, ctx.tenant_id);
    const validation = validateConnectorDraft(
      nextDraft.connector ?? null,
      templates.map((entry) => entry.template),
    );
    return {
      ok: true,
      data: buildLifecyclePayload(nextDraft, {
        connector: nextDraft.connector,
        validation,
      }),
    };
  },
};
