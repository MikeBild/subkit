import { z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { createConnector } from "../../connectors/service.ts";
import { conversations } from "../../db/schema/index.ts";
import { analyzeConversationAttachments } from "../../llm/flows/analyze-conversation-attachments.ts";
import { logger } from "../../logging/logger.ts";
import { withConnectorDraft } from "../authoring-state.ts";
import { toCreateConnectorInput, validateConnectorDraft } from "../connector-draft.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    force: z
      .boolean()
      .default(false)
      .describe("Allow saving even when probe was skipped or failed."),
  })
  .openapi("SaveConnectorDraftToolInput");

export const saveConnectorDraftTool: ConversationTool = {
  name: "save_connector_draft",
  description:
    "Persist the current connector draft as a real connector after validation and probing. Use this only when the draft is ready to save.",
  inputSchema,
  category: "tenant_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const draft = ctx.getDraft();
    const connector = draft.connector;
    const validation = validateConnectorDraft(connector ?? null);
    if (!connector) {
      return { ok: false, data: { error: "start a connector draft first" } };
    }
    if (!validation.ok) {
      await ctx.setDraft(
        withConnectorDraft(draft, { ...connector, validation }, "connector_save_blocked"),
      );
      return {
        ok: false,
        data: {
          error: "connector draft is invalid",
          validation,
        },
      };
    }
    // Every driver we can safely probe (http / graphql / postgres / s3)
    // enforces probe-before-save symmetrically. The override path remains
    // via `force: true`, which records CONNECTOR_SAVED_OVERRIDE.
    const requiresProbe =
      connector.driver === "http" ||
      connector.driver === "graphql" ||
      connector.driver === "postgres" ||
      connector.driver === "s3";
    if (requiresProbe && connector.latest_probe?.ok !== true && !args.force) {
      return {
        ok: false,
        data: {
          error: "probe_required",
          message: "probe the connector draft successfully before saving, or retry with force=true",
          latest_probe: connector.latest_probe ?? null,
        },
      };
    }
    const saved = await createConnector(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.actor_id,
        input: toCreateConnectorInput(connector),
      },
      ctx.db,
    );
    const skippedProbe = requiresProbe && connector.latest_probe?.ok !== true;
    if (args.force && skippedProbe) {
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type: ctx.actor_id ? "user" : "system",
          actor_id: ctx.actor_id,
          action: AuditAction.CONNECTOR_SAVED_OVERRIDE,
          resource_type: "connector",
          resource_id: saved.id,
          result: "success",
          metadata: {
            conversation_id: ctx.conversation_id,
            slug: saved.slug,
            driver: saved.driver,
            environment: saved.environment,
            latest_probe_ok: connector.latest_probe?.ok ?? null,
            latest_probe_code: connector.latest_probe?.failure_code ?? null,
          },
        },
        ctx.db,
      );
    }
    await ctx.db
      .update(conversations)
      .set({
        target_connector_id: saved.id,
        updated_at: new Date(),
      })
      .where(eq(conversations.id, ctx.conversation_id));

    // Attachment-driven endpoint extraction. Best-effort: failures here
    // never block the save — the connector is already persisted, and a
    // missing endpoint registry is recoverable from a later analyse step.
    let analysis: { source_format: string; confidence: number; endpoint_count: number } | null =
      null;
    try {
      const result = await analyzeConversationAttachments({
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        db: ctx.db,
        connector_id: saved.id,
      });
      if (result) {
        analysis = {
          source_format: result.source_format,
          confidence: result.confidence,
          endpoint_count: result.endpoints.length,
        };
      }
    } catch (err) {
      logger.warn({
        module: "save-connector-draft",
        action: "document_analysis_failed",
        tenant_id: ctx.tenant_id,
        connector_id: saved.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await ctx.setDraft(
      withConnectorDraft(
        draft,
        {
          ...connector,
          validation,
          saved_connector_id: saved.id,
        },
        "connector_saved",
      ),
    );
    return {
      ok: true,
      data: {
        connector: {
          id: saved.id,
          slug: saved.slug,
          display_name: saved.display_name,
          environment: saved.environment,
          driver: saved.driver,
        },
        ...(analysis ? { document_analysis: analysis } : {}),
      },
    };
  },
};
