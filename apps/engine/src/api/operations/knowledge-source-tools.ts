import { z } from "@hono/zod-openapi";
import type { Actor } from "../../audit/actor.ts";
import type { ToolContext, ToolResult } from "../../conversations/tools/index.ts";
import type { KnowledgeSourceView, UpdateKnowledgeSourceInput } from "../../knowledge/types.ts";
import { listedDescription } from "../catalog-metadata.ts";
import { isRejection, type OperationActor, type Rejection } from "./index.ts";

export const ListKnowledgeSourcesToolInput = z
  .object({
    category: z
      .string()
      .optional()
      .describe("Only sources in this catalog block (see `category` on each source)."),
  })
  .openapi("ListKnowledgeSourcesToolInput");

export const GetKnowledgeSourceToolInput = z
  .object({ id: z.string().uuid() })
  .openapi("GetKnowledgeSourceToolInput");

export const UpdateKnowledgeSourceToolInput = z
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

export const AnalyzeKnowledgeSourceToolInput = z
  .object({
    id: z.string().uuid("knowledge source id must be a UUID"),
    force: z.boolean().optional(),
  })
  .openapi("AnalyzeKnowledgeSourceToolInput");

type UpdateToolArgs = z.infer<typeof UpdateKnowledgeSourceToolInput>;

export function knowledgeActorOf(actor: OperationActor): Actor | { kind: "unknown" } | null {
  if (actor.type === "unknown") return { kind: "unknown" };
  if (actor.type === "system" || actor.id === null) return null;
  return { kind: actor.type, id: actor.id };
}

export function patchFromToolArgs(args: UpdateToolArgs): UpdateKnowledgeSourceInput {
  return {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.tags !== undefined ? { tags: args.tags } : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.workflow_id !== undefined ? { workflow_id: args.workflow_id } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.refresh_strategy !== undefined ? { refresh_strategy: args.refresh_strategy } : {}),
    ...(args.refresh_cron !== undefined ? { refresh_cron: args.refresh_cron } : {}),
  };
}

export function listToolResult(
  outcome: { readonly items: KnowledgeSourceView[] } | Rejection,
  category: string | undefined,
): ToolResult {
  if (isRejection(outcome)) return { ok: false, data: { error: outcome.code } };
  const all = outcome.items;
  const rows = all.filter((k) => category === undefined || k.category === category);
  const filtered =
    category === undefined
      ? {}
      : {
          category_filter: category,
          total_sources: all.length,
          categories: [...new Set(all.map((k) => k.category))].sort(),
          ...(rows.length === 0 && all.length > 0
            ? {
                hint: `No source in category '${category}', but the workspace has ${all.length} source(s) in other categories, listed in sources_in_other_categories. Use them before telling the person nothing was found.`,
                sources_in_other_categories: all.slice(0, 25).map((k) => ({
                  id: k.id,
                  name: k.name,
                  category: k.category,
                })),
              }
            : {}),
        };
  return {
    ok: true,
    data: {
      ...filtered,
      sources: rows.map((k) => ({
        id: k.id,
        name: k.name,
        slug: k.slug,
        description: listedDescription(k.description),
        category: k.category,
        tags: k.tags,
        scope: k.scope,
        status: k.status,
        source_type: k.source_type,
        version: k.version,
        chunk_count: k.chunk_count,
      })),
    },
  };
}

function notFound(id: string): ToolResult {
  return { ok: false, data: { error: "knowledge_source_not_found", id } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function updateToolResult(
  outcome: KnowledgeSourceView | Rejection,
  input: { readonly id: string; readonly fields?: readonly string[] },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (isRejection(outcome)) {
    if (outcome.status === 404) return notFound(input.id);
    return { ok: false, data: { error: "update_failed", message: outcome.message } };
  }
  const audit_log_id = await ctx.engineClient.audit_write({
    resource_type: "knowledge_source",
    resource_id: outcome.id,
    action: "conversation.update_knowledge_source",
    result: "success",
    metadata: { conversation_id: ctx.conversation_id, fields: input.fields ?? [] },
  });
  return {
    ok: true,
    data: {
      updated: true,
      knowledge_source: {
        id: outcome.id,
        name: outcome.name,
        tags: outcome.tags,
        scope: outcome.scope,
        status: outcome.status,
      },
      audit_log_id,
    },
  };
}

export function updateToolError(error: unknown): ToolResult {
  const msg = errorMessage(error);
  if (msg.includes("workflow_id is required when scope is 'workflow'")) {
    return { ok: false, data: { error: "scope_workflow_requires_workflow_id", message: msg } };
  }
  return { ok: false, data: { error: "update_failed", message: msg } };
}

export async function analyzeToolResult(
  outcome: KnowledgeSourceView | Rejection,
  input: { readonly id: string; readonly force?: boolean },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (isRejection(outcome)) {
    if (outcome.status === 404) return notFound(input.id);
    return { ok: false, data: { error: "analyze_failed", message: outcome.message } };
  }
  const audit_log_id = await ctx.engineClient.audit_write({
    resource_type: "knowledge_source",
    resource_id: outcome.id,
    action: "conversation.analyze_knowledge_source",
    result: "success",
    metadata: {
      conversation_id: ctx.conversation_id,
      tags: outcome.tags,
      force: input.force === true,
    },
  });
  return {
    ok: true,
    data: {
      analyzed: true,
      knowledge_source: {
        id: outcome.id,
        name: outcome.name,
        description: outcome.description,
        tags: outcome.tags,
        status: outcome.status,
      },
      audit_log_id,
    },
  };
}

export function analyzeToolError(error: unknown): ToolResult {
  return { ok: false, data: { error: "analyze_failed", message: errorMessage(error) } };
}
