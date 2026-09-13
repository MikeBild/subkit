// analyze_knowledge_source — LLM-enrich a persisted Knowledge Source's
// metadata (description + topical tags). Reuses the same
// `analyzeKnowledgeSource` service path the interactive upload sites and
// the HTTP `POST /:id/analyze` route call.
//
// Pattern parity with create_knowledge_source / update_knowledge_source:
// `category: "tenant_write"`, inline `knowledge:write` RBAC check, an
// audit_log row before returning. NEVER renames name/slug — analysis
// enriches metadata only. `tags` are a deduped REPLACEMENT set; the
// description is overwritten only when currently null OR force=true.

import { z } from "@hono/zod-openapi";

import type { ConversationTool } from "../../index.ts";

const AnalyzeKnowledgeSourceInput = z
  .object({
    id: z.string().uuid("knowledge source id must be a UUID"),
    // Overwrite an existing description; otherwise only a null description
    // is filled. Tags are always replaced with the freshly generated set.
    force: z.boolean().optional(),
  })
  .openapi("AnalyzeKnowledgeSourceToolInput");

export const analyzeKnowledgeSourceTool: ConversationTool = {
  name: "analyze_knowledge_source",
  description:
    "Generate a description and topical tags for a persisted Knowledge Source by reading its first chunks. Use this to make a legacy source (uploaded without a description, or with no tags) self-describing and routable. Tags are replaced with a freshly generated set; the description is only overwritten when force=true.",
  use_case:
    "Use when the user asks to summarise, describe, tag, or 're-analyze' an existing Knowledge Source, or when list_knowledge_sources shows a source with a null description / empty tags. Pass force=true to regenerate an existing description.",
  important_notes: [
    "Never renames the source — analysis enriches description + tags only.",
    "tags are a deduped replacement set (3-8 short topical tags).",
    "description is overwritten only when currently empty or force=true.",
    "Counts against the tenant LLM budget; one model call per analyze.",
  ],
  inputSchema: AnalyzeKnowledgeSourceInput,
  category: "tenant_write",
  permission: { action: "knowledge:write", resourceType: "knowledge", resourceIdArg: "id" },
  async execute(ctx, args: z.infer<typeof AnalyzeKnowledgeSourceInput>) {
    try {
      const view = await ctx.engineClient.knowledgeSources.analyze(args.id, {
        ...(args.force !== undefined ? { force: args.force } : {}),
      });

      if (!view) {
        return { ok: false, data: { error: "knowledge_source_not_found", id: args.id } };
      }

      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "knowledge_source",
        resource_id: view.id,
        action: "conversation.analyze_knowledge_source",
        result: "success",
        metadata: {
          conversation_id: ctx.conversation_id,
          tags: view.tags,
          force: args.force === true,
        },
      });

      return {
        ok: true,
        data: {
          analyzed: true,
          knowledge_source: {
            id: view.id,
            name: view.name,
            description: view.description,
            tags: view.tags,
            status: view.status,
          },
          audit_log_id,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: { error: "analyze_failed", message: msg } };
    }
  },
};
