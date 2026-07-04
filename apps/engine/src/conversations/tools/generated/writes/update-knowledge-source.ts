// update_knowledge_source — patch a persisted knowledge source's
// metadata (name, description, scope, status, refresh strategy).
// Generic patch shape; send only the fields that should change.
//
// Pattern parity with update_workflow / update_connector /
// update_schedule. Audit funnels through the existing
// `knowledge_source.updated` action — no new audit-action enum entry.

import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../../index.ts";

const UpdateKnowledgeSourceInput = z
  .object({
    id: z.string().uuid("knowledge source id must be a UUID"),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    scope: z.enum(["global", "workflow"]).optional(),
    workflow_id: z.string().uuid().nullable().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    refresh_strategy: z.enum(["manual", "scheduled"]).optional(),
    refresh_cron: z.string().nullable().optional(),
  })
  .refine(
    (v) =>
      Boolean(
        v.name ||
          v.description ||
          v.tags !== undefined ||
          v.scope ||
          v.workflow_id !== undefined ||
          v.status ||
          v.refresh_strategy ||
          v.refresh_cron !== undefined,
      ),
    { message: "At least one patch field is required" },
  )
  .openapi("UpdateKnowledgeSourceToolInput");

export const updateKnowledgeSourceTool: ConversationTool = {
  name: "update_knowledge_source",
  description:
    "Patch a persisted knowledge source — rename, edit its description/tags, retarget the workflow scope, change status, or change refresh cadence.",
  use_case:
    "Use when the user asks to rename a knowledge source, set its description or tags, archive it (status='inactive'), repoint it to a different workflow scope, or change its refresh cadence. To auto-generate a description/tags from the content instead of dictating them, use analyze_knowledge_source. Send only the fields that should change.",
  important_notes: [
    "At least one patch field is required.",
    "Switching scope to 'workflow' requires workflow_id to be set (either in this patch or already on the row).",
    "Audits as knowledge_source.updated with full before/after snapshots — never overrides ingested chunk history.",
  ],
  inputSchema: UpdateKnowledgeSourceInput,
  category: "tenant_write",
  permission: { action: "knowledge:write", resourceType: "knowledge", resourceIdArg: "id" },
  async execute(ctx, rawArgs) {
    const args = UpdateKnowledgeSourceInput.parse(rawArgs);
    try {
      const view = await ctx.engineClient.knowledgeSources.update(args.id, {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        ...(args.workflow_id !== undefined ? { workflow_id: args.workflow_id } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.refresh_strategy !== undefined ? { refresh_strategy: args.refresh_strategy } : {}),
        ...(args.refresh_cron !== undefined ? { refresh_cron: args.refresh_cron } : {}),
      });

      if (!view) {
        return { ok: false, data: { error: "knowledge_source_not_found", id: args.id } };
      }

      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "knowledge_source",
        resource_id: view.id,
        action: "conversation.update_knowledge_source",
        result: "success",
        metadata: {
          conversation_id: ctx.conversation_id,
          fields: Object.keys(args).filter((k) => k !== "id"),
        },
      });

      return {
        ok: true,
        data: {
          updated: true,
          knowledge_source: {
            id: view.id,
            name: view.name,
            tags: view.tags,
            scope: view.scope,
            status: view.status,
          },
          audit_log_id,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("workflow_id is required when scope is 'workflow'")) {
        return { ok: false, data: { error: "scope_workflow_requires_workflow_id", message: msg } };
      }
      return { ok: false, data: { error: "update_failed", message: msg } };
    }
  },
};
